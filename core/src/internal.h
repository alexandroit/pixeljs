#ifndef PIXELJS_INTERNAL_H
#define PIXELJS_INTERNAL_H

#include "pixeljs/pixeljs.h"
#include "pixeljs/protocol.h"
#include <limits.h>
#include <stdbool.h>

_Static_assert(CHAR_BIT == 8, "PixelJS requires 8-bit bytes");
_Static_assert(sizeof(uint32_t) == 4, "PixelJS requires 32-bit uint32_t");

#define PX_GENERATION_MAX UINT32_C(1048575)
#define PX_SLOT_MASK UINT32_C(4095)
#define PX_BUILTIN_GLYPH_SIZE UINT32_C(8)

/* Kind-specific metadata is validated once at commit and immutable afterwards.
 * width/height hold image pixels, tilemap cells or font glyph pixels. */
typedef struct px_image_info {
    uint32_t transparency;
} px_image_info;

typedef struct px_tilemap_info {
    uint32_t tile_width;
    uint32_t tile_height;
    uint32_t tileset;       /* Retained image handle: releasing it fails while mapped. */
    uint32_t tiles_per_row; /* Whole tiles in one tileset row; always nonzero. */
} px_tilemap_info;

typedef struct px_font_info {
    uint32_t first_char;
    uint32_t char_count;
    uint32_t fallback_glyph; /* Glyph index drawn for characters outside the font. */
    uint32_t row_bytes;      /* Bytes per glyph row: ceil(width / 8), MSB first. */
} px_font_info;

typedef struct px_resource_slot {
    uint8_t *storage; /* Owned allocation: 32-byte header followed by the payload. */
    size_t storage_bytes;
    uint32_t kind;
    uint32_t width;
    uint32_t height;
    uint32_t generation;
    bool retired;
    union {
        px_image_info image;
        px_tilemap_info tilemap;
        px_font_info font;
    } as;
} px_resource_slot;

struct px_context {
    px_config config;
    px_allocator allocator;
    size_t live_bytes;
    size_t allocation_count;
    size_t frame_bytes;
    uint8_t *frame;
    uint8_t *rgba;
    /* One seed per framebuffer pixel bounds every flood fill; preallocated so
     * submission never allocates. */
    uint32_t *fill_stack;
    /* All 256 RGBA entries are always initialized; only the first
     * config.palette_count indices are accepted by validation. */
    uint8_t palette[PX_MAX_PALETTE_COLORS * 4];
    uint32_t palette_revision;
    px_resource_slot resources[PX_MAX_RESOURCES];
    uint8_t *staging;
    size_t staging_size;
    size_t staging_cursor;
    uint32_t staging_kind;
    uint32_t last_resource_handle;
    px_diagnostic diagnostic;
    bool busy;
};

typedef struct px_draw_state {
    int64_t camera_x;
    int64_t camera_y;
    int64_t clip_left;
    int64_t clip_top;
    int64_t clip_right;
    int64_t clip_bottom;
    /* Every index a draw command writes passes through this table. */
    uint8_t remap[PX_MAX_PALETTE_COLORS];
} px_draw_state;

typedef struct px_command {
    uint16_t opcode;
    uint16_t flags;
    uint32_t handle;
    int32_t args[6];
    /* Arguments of the PARAMS record that follows TRIANGLE, TRIANGLE_FILL
     * and BLIT_TRANSFORM; zero for every other opcode. */
    int32_t params[6];
} px_command;

typedef struct px_region {
    int64_t left;
    int64_t top;
    int64_t right;
    int64_t bottom;
} px_region;

uint16_t px_read_u16(const uint8_t *bytes);
uint32_t px_read_u32(const uint8_t *bytes);
int32_t px_read_i32(const uint8_t *bytes);
bool px_dimensions_size(uint32_t width, uint32_t height, size_t *out_size);
void *px_allocate(px_context *context, size_t size);
void px_deallocate(px_context *context, void *memory, size_t size);
px_result px_finish(px_context *context, px_result result);
px_result px_enter(px_context *context);
const px_resource_slot *px_find_resource(const px_context *context, uint32_t handle);
const px_resource_slot *px_find_image(const px_context *context, uint32_t handle);
const px_resource_slot *px_find_tilemap(const px_context *context, uint32_t handle);
const px_resource_slot *px_find_font(const px_context *context, uint32_t handle);
void px_reset_draw_state(const px_context *context, px_draw_state *state);
/* Camera and clip only. Palette records are applied by px_apply_palette in the
 * write pass, so a rejected batch can never publish a partial palette. */
void px_apply_state(const px_context *context, px_draw_state *state, const px_command *command);
void px_apply_palette(px_context *context, const px_command *command);
bool px_opcode_has_params(uint16_t opcode);
/* Conservative number of bounded inner-loop steps the command will execute.
 * Submission sums this for the whole batch before the first write. */
uint64_t px_command_work(const px_context *context, const px_draw_state *state,
                         const px_command *command, const px_resource_slot *resource);
/* Returns the work performed in the same units; debug builds assert that it
 * never exceeds px_command_work. */
uint64_t px_raster_command(px_context *context, const px_draw_state *state,
                           const px_command *command, const px_resource_slot *resource);

#endif
