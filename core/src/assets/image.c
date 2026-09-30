#include "internal.h"
#include <string.h>

const px_resource_slot *px_find_resource(const px_context *context, uint32_t handle) {
    const uint32_t encoded_slot = handle & PX_SLOT_MASK;
    const uint32_t generation = handle >> 12;
    if (encoded_slot == 0 || encoded_slot > PX_MAX_RESOURCES || generation == 0) {
        return NULL;
    }
    const px_resource_slot *slot = &context->resources[encoded_slot - 1];
    return slot->storage != NULL && !slot->retired && slot->generation == generation ? slot : NULL;
}

static const px_resource_slot *px_find_kind(const px_context *context, uint32_t handle,
                                            uint32_t kind) {
    const px_resource_slot *slot = px_find_resource(context, handle);
    return slot != NULL && slot->kind == kind ? slot : NULL;
}

const px_resource_slot *px_find_image(const px_context *context, uint32_t handle) {
    return px_find_kind(context, handle, PX_IMAGE_KIND);
}

const px_resource_slot *px_find_tilemap(const px_context *context, uint32_t handle) {
    return px_find_kind(context, handle, PX_TILEMAP_KIND);
}

const px_resource_slot *px_find_font(const px_context *context, uint32_t handle) {
    return px_find_kind(context, handle, PX_FONT_KIND);
}

px_result px_upload_begin(px_context *context, uint32_t kind, size_t total_bytes) {
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    context->last_resource_handle = 0;
    if (context->staging != NULL) {
        return px_finish(context, PX_ERR_STATE);
    }
    if (kind != PX_IMAGE_KIND && kind != PX_TILEMAP_KIND && kind != PX_FONT_KIND) {
        return px_finish(context, PX_ERR_UNSUPPORTED);
    }
    if (total_bytes < PX_HEADER_BYTES || total_bytes > PX_MAX_UPLOAD_BYTES) {
        return px_finish(context, PX_ERR_RANGE);
    }
    context->staging = px_allocate(context, total_bytes);
    if (context->staging == NULL) {
        return px_finish(context, PX_ERR_OUT_OF_MEMORY);
    }
    context->staging_size = total_bytes;
    context->staging_cursor = 0;
    context->staging_kind = kind;
    return px_finish(context, PX_OK);
}

px_result px_upload_chunk(px_context *context, const uint8_t *bytes, size_t length) {
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    context->last_resource_handle = 0;
    if (context->staging == NULL) {
        return px_finish(context, PX_ERR_STATE);
    }
    if (bytes == NULL || length == 0) {
        return px_finish(context, PX_ERR_ARGUMENT);
    }
    if (length > PX_MAILBOX_BYTES || context->staging_cursor > context->staging_size ||
        length > context->staging_size - context->staging_cursor) {
        return px_finish(context, PX_ERR_CAPACITY);
    }
    memcpy(context->staging + context->staging_cursor, bytes, length);
    context->staging_cursor += length;
    return px_finish(context, PX_OK);
}

/* Every validator reads only the completed staging buffer and fills the slot
 * metadata in *out; nothing is published unless it returns PX_OK. */
static px_result px_validate_image(const px_context *context, px_resource_slot *out) {
    const uint8_t *bytes = context->staging;
    if (memcmp(bytes, "PXIM", 4) != 0 || px_read_u32(bytes + 4) != PX_IMAGE_VERSION ||
        px_read_u32(bytes + 20) != context->staging_size || px_read_u32(bytes + 24) != 0 ||
        px_read_u32(bytes + 28) != 0) {
        return PX_ERR_PROTOCOL;
    }
    const uint32_t width = px_read_u32(bytes + 8);
    const uint32_t height = px_read_u32(bytes + 12);
    const uint32_t transparency = px_read_u32(bytes + 16);
    size_t pixel_count = 0;
    if (!px_dimensions_size(width, height, &pixel_count) ||
        pixel_count != context->staging_size - PX_HEADER_BYTES ||
        (transparency != PX_NO_TRANSPARENCY && transparency >= context->config.palette_count)) {
        return PX_ERR_RANGE;
    }
    for (size_t index = PX_HEADER_BYTES; index < context->staging_size; ++index) {
        if (bytes[index] >= context->config.palette_count) {
            return PX_ERR_RANGE;
        }
    }
    out->width = width;
    out->height = height;
    out->as.image.transparency = transparency;
    return PX_OK;
}

static px_result px_validate_tilemap(const px_context *context, px_resource_slot *out) {
    const uint8_t *bytes = context->staging;
    if (memcmp(bytes, "PXTM", 4) != 0 || px_read_u32(bytes + 4) != PX_TILEMAP_VERSION ||
        px_read_u32(bytes + 28) != context->staging_size) {
        return PX_ERR_PROTOCOL;
    }
    const uint32_t columns = px_read_u32(bytes + 8);
    const uint32_t rows = px_read_u32(bytes + 12);
    const uint32_t tile_width = px_read_u32(bytes + 16);
    const uint32_t tile_height = px_read_u32(bytes + 20);
    const uint32_t tileset_handle = px_read_u32(bytes + 24);
    size_t cell_count = 0;
    if (!px_dimensions_size(columns, rows, &cell_count) || tile_width == 0 ||
        tile_width > PX_MAX_TILE_DIMENSION || tile_height == 0 ||
        tile_height > PX_MAX_TILE_DIMENSION) {
        return PX_ERR_RANGE;
    }
    if (context->staging_size != PX_HEADER_BYTES + cell_count * 2) {
        return PX_ERR_PROTOCOL;
    }
    const px_resource_slot *tileset = px_find_image(context, tileset_handle);
    if (tileset == NULL) {
        return PX_ERR_HANDLE;
    }
    /* Only whole tiles are addressable, so a valid ID never reads outside the
     * tileset and drawing needs no per-pixel source bounds checks. */
    const uint32_t tiles_per_row = tileset->width / tile_width;
    const uint32_t tile_rows = tileset->height / tile_height;
    if (tiles_per_row == 0 || tile_rows == 0) {
        return PX_ERR_RANGE;
    }
    const uint32_t tile_count = tiles_per_row * tile_rows;
    for (size_t cell = 0; cell < cell_count; ++cell) {
        const uint32_t tile = px_read_u16(bytes + PX_HEADER_BYTES + cell * 2);
        if (tile != PX_EMPTY_TILE && tile >= tile_count) {
            return PX_ERR_RANGE;
        }
    }
    out->width = columns;
    out->height = rows;
    out->as.tilemap.tile_width = tile_width;
    out->as.tilemap.tile_height = tile_height;
    out->as.tilemap.tileset = tileset_handle;
    out->as.tilemap.tiles_per_row = tiles_per_row;
    return PX_OK;
}

static px_result px_validate_font(const px_context *context, px_resource_slot *out) {
    const uint8_t *bytes = context->staging;
    if (memcmp(bytes, "PXFN", 4) != 0 || px_read_u32(bytes + 4) != PX_FONT_VERSION ||
        px_read_u32(bytes + 28) != context->staging_size) {
        return PX_ERR_PROTOCOL;
    }
    const uint32_t glyph_width = px_read_u32(bytes + 8);
    const uint32_t glyph_height = px_read_u32(bytes + 12);
    const uint32_t first_char = px_read_u32(bytes + 16);
    const uint32_t char_count = px_read_u32(bytes + 20);
    const uint32_t fallback_char = px_read_u32(bytes + 24);
    if (glyph_width == 0 || glyph_width > PX_MAX_GLYPH_DIMENSION || glyph_height == 0 ||
        glyph_height > PX_MAX_GLYPH_DIMENSION || char_count == 0 || char_count > PX_MAX_GLYPHS ||
        first_char > PX_MAX_CHAR_CODE || char_count - 1 > PX_MAX_CHAR_CODE - first_char ||
        fallback_char < first_char || fallback_char - first_char >= char_count) {
        return PX_ERR_RANGE;
    }
    /* Rows are padded to whole bytes: bit 7 of the first byte is the left pixel. */
    const size_t row_bytes = ((size_t)glyph_width + 7) / 8;
    const size_t glyph_bytes = row_bytes * glyph_height;
    if (context->staging_size != PX_HEADER_BYTES + (size_t)char_count * glyph_bytes) {
        return PX_ERR_PROTOCOL;
    }
    out->width = glyph_width;
    out->height = glyph_height;
    out->as.font.first_char = first_char;
    out->as.font.char_count = char_count;
    out->as.font.fallback_glyph = fallback_char - first_char;
    out->as.font.row_bytes = (uint32_t)row_bytes;
    return PX_OK;
}

px_result px_upload_commit(px_context *context) {
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    context->last_resource_handle = 0;
    if (context->staging == NULL || context->staging_cursor != context->staging_size) {
        return px_finish(context, PX_ERR_STATE);
    }
    px_resource_slot validated;
    memset(&validated, 0, sizeof(validated));
    px_result validation = PX_ERR_UNSUPPORTED;
    if (context->staging_kind == PX_IMAGE_KIND) {
        validation = px_validate_image(context, &validated);
    } else if (context->staging_kind == PX_TILEMAP_KIND) {
        validation = px_validate_tilemap(context, &validated);
    } else if (context->staging_kind == PX_FONT_KIND) {
        validation = px_validate_font(context, &validated);
    }
    if (validation != PX_OK) {
        return px_finish(context, validation);
    }
    for (uint32_t index = 0; index < PX_MAX_RESOURCES; ++index) {
        px_resource_slot *slot = &context->resources[index];
        if (slot->storage == NULL && !slot->retired) {
            /* Publication moves the staging allocation; commit never allocates. */
            slot->storage = context->staging;
            slot->storage_bytes = context->staging_size;
            slot->kind = context->staging_kind;
            slot->width = validated.width;
            slot->height = validated.height;
            slot->as = validated.as;
            context->staging = NULL;
            context->staging_size = 0;
            context->staging_cursor = 0;
            context->staging_kind = 0;
            context->last_resource_handle = (slot->generation << 12) | (index + 1);
            return px_finish(context, PX_OK);
        }
    }
    return px_finish(context, PX_ERR_CAPACITY);
}

px_result px_upload_abort(px_context *context) {
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    context->last_resource_handle = 0;
    px_deallocate(context, context->staging, context->staging_size);
    context->staging = NULL;
    context->staging_size = 0;
    context->staging_cursor = 0;
    context->staging_kind = 0;
    return px_finish(context, PX_OK);
}

uint32_t px_last_resource_handle(const px_context *context) {
    return context != NULL ? context->last_resource_handle : 0;
}

px_result px_resource_release(px_context *context, uint32_t handle) {
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    context->last_resource_handle = 0;
    const px_resource_slot *found = px_find_resource(context, handle);
    if (found == NULL) {
        return px_finish(context, PX_ERR_HANDLE);
    }
    /* A tilemap retains its tileset: the image stays valid and releasable later. */
    for (size_t index = 0; index < PX_MAX_RESOURCES; ++index) {
        const px_resource_slot *dependent = &context->resources[index];
        if (dependent->storage != NULL && dependent->kind == PX_TILEMAP_KIND &&
            dependent->as.tilemap.tileset == handle) {
            return px_finish(context, PX_ERR_RESOURCE_IN_USE);
        }
    }
    px_resource_slot *slot = &context->resources[(handle & PX_SLOT_MASK) - 1];
    px_deallocate(context, slot->storage, slot->storage_bytes);
    slot->storage = NULL;
    slot->storage_bytes = 0;
    slot->kind = 0;
    if (slot->generation == PX_GENERATION_MAX) {
        slot->retired = true;
    } else {
        slot->generation += 1;
    }
    return px_finish(context, PX_OK);
}
