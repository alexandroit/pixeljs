#include "internal.h"
#include <stdlib.h>
#include <string.h>

static void *px_default_allocate(void *userdata, size_t size) {
    (void)userdata;
    return malloc(size);
}

static void px_default_deallocate(void *userdata, void *memory, size_t size) {
    (void)userdata;
    (void)size;
    free(memory);
}

static void px_initialize_palette(px_context *context) {
    /* Original PixelJS colors: designed here, independent of reference assets. */
    static const uint8_t colors[16][3] = {
        {13, 17, 28},    {36, 44, 66},    {71, 77, 111},   {121, 128, 154},
        {231, 239, 246}, {250, 105, 93},  {249, 167, 90},  {255, 220, 128},
        {159, 216, 107}, {56, 173, 135},  {50, 218, 202},  {63, 135, 212},
        {121, 95, 206},  {182, 118, 214}, {240, 163, 199}, {122, 82, 66}};
    for (size_t index = 0; index < PX_MAX_PALETTE_COLORS; ++index) {
        memcpy(context->palette + index * 4, colors[index % 16], 3);
        context->palette[index * 4 + 3] = 255;
    }
    context->palette_revision = 1;
}

px_result px_context_create(const px_config *config, const px_allocator *allocator,
                            px_context **out_context) {
    if (out_context == NULL) {
        return PX_ERR_ARGUMENT;
    }
    *out_context = NULL;
    if (config == NULL ||
        (allocator != NULL && (allocator->allocate == NULL || allocator->deallocate == NULL))) {
        return PX_ERR_ARGUMENT;
    }
    size_t frame_size = 0;
    if (!px_dimensions_size(config->width, config->height, &frame_size) ||
        config->palette_count == 0 || config->palette_count > PX_MAX_PALETTE_COLORS ||
        config->memory_budget_bytes > PX_MEMORY_BUDGET_BYTES || frame_size > SIZE_MAX / 4) {
        return PX_ERR_RANGE;
    }
    if (config->memory_budget_bytes < sizeof(px_context)) {
        return PX_ERR_OUT_OF_MEMORY;
    }
    const px_allocator selected =
        allocator != NULL ? *allocator
                          : (px_allocator){NULL, px_default_allocate, px_default_deallocate};
    px_context *context = selected.allocate(selected.userdata, sizeof(*context));
    if (context == NULL) {
        return PX_ERR_OUT_OF_MEMORY;
    }
    memset(context, 0, sizeof(*context));
    context->config = *config;
    context->allocator = selected;
    context->live_bytes = sizeof(*context);
    context->allocation_count = 1;
    context->frame_bytes = frame_size;
    context->frame = px_allocate(context, frame_size);
    if (context->frame == NULL) {
        goto out_of_memory;
    }
    context->rgba = px_allocate(context, frame_size * 4);
    if (context->rgba == NULL) {
        goto out_of_memory;
    }
    context->fill_stack = px_allocate(context, frame_size * sizeof(uint32_t));
    if (context->fill_stack == NULL) {
        goto out_of_memory;
    }
    memset(context->frame, 0, frame_size);
    memset(context->rgba, 0, frame_size * 4);
    for (size_t index = 0; index < PX_MAX_RESOURCES; ++index) {
        context->resources[index].generation = 1;
    }
    px_initialize_palette(context);
    (void)px_finish(context, PX_OK);
    *out_context = context;
    return PX_OK;

out_of_memory:
    px_context_destroy(context);
    return PX_ERR_OUT_OF_MEMORY;
}

void px_context_destroy(px_context *context) {
    if (context == NULL) {
        return;
    }
    for (size_t index = 0; index < PX_MAX_RESOURCES; ++index) {
        px_deallocate(context, context->resources[index].storage,
                      context->resources[index].storage_bytes);
    }
    px_deallocate(context, context->staging, context->staging_size);
    px_deallocate(context, context->fill_stack, context->frame_bytes * sizeof(uint32_t));
    px_deallocate(context, context->rgba, context->frame_bytes * 4);
    px_deallocate(context, context->frame, context->frame_bytes);
    const px_allocator allocator = context->allocator;
    allocator.deallocate(allocator.userdata, context, sizeof(*context));
}

const uint8_t *px_frame_data(const px_context *context) {
    return context != NULL ? context->frame : NULL;
}

const uint8_t *px_palette_data(const px_context *context) {
    return context != NULL ? context->palette : NULL;
}

const uint8_t *px_rgba_data(const px_context *context) {
    return context != NULL ? context->rgba : NULL;
}

uint32_t px_frame_stride(const px_context *context) {
    return context != NULL ? context->config.width : 0;
}

size_t px_frame_size(const px_context *context) {
    return context != NULL ? context->frame_bytes : 0;
}

px_result px_expand_rgba(px_context *context) {
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    for (size_t index = 0; index < context->frame_bytes; ++index) {
        memcpy(context->rgba + index * 4, context->palette + (size_t)context->frame[index] * 4, 4);
    }
    return px_finish(context, PX_OK);
}

px_diagnostic px_last_diagnostic(const px_context *context) {
    return context != NULL ? context->diagnostic
                           : (px_diagnostic){PX_ERR_STATE, PX_NO_COMMAND, PX_NO_COMMAND};
}

size_t px_live_bytes(const px_context *context) {
    return context != NULL ? context->live_bytes : 0;
}

size_t px_allocation_count(const px_context *context) {
    return context != NULL ? context->allocation_count : 0;
}

px_result px_context_resize(px_context *context, uint32_t width, uint32_t height) {
    if (context == NULL) {
        return PX_ERR_ARGUMENT;
    }
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    if (width == 0 || height == 0 || width > PX_MAX_DIMENSION || height > PX_MAX_DIMENSION) {
        return px_finish(context, PX_ERR_RANGE);
    }
    size_t new_frame_size = 0;
    if (!px_dimensions_size(width, height, &new_frame_size) || new_frame_size > SIZE_MAX / 4) {
        return px_finish(context, PX_ERR_RANGE);
    }
    if (width == context->config.width && height == context->config.height) {
        return px_finish(context, PX_OK);
    }
    uint8_t *new_frame = px_allocate(context, new_frame_size);
    if (new_frame == NULL) {
        return px_finish(context, PX_ERR_OUT_OF_MEMORY);
    }
    uint8_t *new_rgba = px_allocate(context, new_frame_size * 4);
    if (new_rgba == NULL) {
        px_deallocate(context, new_frame, new_frame_size);
        return px_finish(context, PX_ERR_OUT_OF_MEMORY);
    }
    uint32_t *new_fill_stack = px_allocate(context, new_frame_size * sizeof(uint32_t));
    if (new_fill_stack == NULL) {
        px_deallocate(context, new_rgba, new_frame_size * 4);
        px_deallocate(context, new_frame, new_frame_size);
        return px_finish(context, PX_ERR_OUT_OF_MEMORY);
    }
    memset(new_frame, 0, new_frame_size);
    memset(new_rgba, 0, new_frame_size * 4);

    px_deallocate(context, context->frame, context->frame_bytes);
    px_deallocate(context, context->rgba, context->frame_bytes * 4);
    px_deallocate(context, context->fill_stack, context->frame_bytes * sizeof(uint32_t));

    context->frame = new_frame;
    context->rgba = new_rgba;
    context->fill_stack = new_fill_stack;
    context->frame_bytes = new_frame_size;
    context->config.width = width;
    context->config.height = height;

    return px_finish(context, PX_OK);
}

px_result px_context_set_palette(px_context *context, const uint8_t *palette_data, uint32_t count) {
    if (context == NULL) {
        return PX_ERR_ARGUMENT;
    }
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    /* The palette size is fixed when the context is created, so every index
     * already stored in images and the framebuffer stays valid. */
    if (palette_data == NULL || count != context->config.palette_count) {
        return px_finish(context, PX_ERR_RANGE);
    }
    for (size_t index = 0; index < count; ++index) {
        if (palette_data[index * 4 + 3] != 255) {
            return px_finish(context, PX_ERR_RANGE);
        }
    }
    memcpy(context->palette, palette_data, (size_t)count * 4);
    context->palette_revision += 1;
    return px_finish(context, PX_OK);
}

uint32_t px_palette_count(const px_context *context) {
    return context != NULL ? context->config.palette_count : 0;
}

uint32_t px_palette_revision(const px_context *context) {
    return context != NULL ? context->palette_revision : 0;
}
