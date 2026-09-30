#include "internal.h"
#include "font_data.h"
#include "trig_data.h"
#include <assert.h>
#include <string.h>

/* Coordinates reach raster code as int32 arguments minus an int32 camera, so
 * every value below stays under 2^34 in magnitude and int64 sums cannot wrap. */

static int64_t px_max_i64(int64_t left, int64_t right) {
    return left > right ? left : right;
}

static int64_t px_min_i64(int64_t left, int64_t right) {
    return left < right ? left : right;
}

static uint64_t px_magnitude(int64_t value) {
    return value < 0 ? (uint64_t)0 - (uint64_t)value : (uint64_t)value;
}

static const px_region px_empty_region = {0, 0, 0, 0};

static bool px_region_empty(px_region region) {
    return region.right <= region.left || region.bottom <= region.top;
}

static px_region px_clip_box(const px_draw_state *state, int64_t left, int64_t top, int64_t right,
                             int64_t bottom) {
    const px_region region = {px_max_i64(left, state->clip_left), px_max_i64(top, state->clip_top),
                              px_min_i64(right, state->clip_right),
                              px_min_i64(bottom, state->clip_bottom)};
    return px_region_empty(region) ? px_empty_region : region;
}

static uint64_t px_region_area(px_region region) {
    return (uint64_t)(region.right - region.left) * (uint64_t)(region.bottom - region.top);
}

static void px_identity_remap(px_draw_state *state) {
    for (size_t index = 0; index < PX_MAX_PALETTE_COLORS; ++index) {
        state->remap[index] = (uint8_t)index;
    }
}

void px_reset_draw_state(const px_context *context, px_draw_state *state) {
    *state = (px_draw_state){0, 0, 0, 0, (int64_t)context->config.width,
                             (int64_t)context->config.height, {0}};
    px_identity_remap(state);
}

/* The palette index a draw command writes for `color`. */
static uint8_t px_ink(const px_draw_state *state, int32_t color) {
    return state->remap[(uint8_t)color];
}

void px_apply_state(const px_context *context, px_draw_state *state, const px_command *command) {
    if (command->opcode == PX_OP_SET_CAMERA) {
        state->camera_x = command->args[0];
        state->camera_y = command->args[1];
    } else if (command->opcode == PX_OP_SET_CLIP) {
        state->clip_left = px_max_i64(0, command->args[0]);
        state->clip_top = px_max_i64(0, command->args[1]);
        state->clip_right =
            px_min_i64((int64_t)context->config.width, (int64_t)command->args[0] + command->args[2]);
        state->clip_bottom =
            px_min_i64((int64_t)context->config.height, (int64_t)command->args[1] + command->args[3]);
    } else if (command->opcode == PX_OP_RESET_CLIP) {
        state->clip_left = 0;
        state->clip_top = 0;
        state->clip_right = (int64_t)context->config.width;
        state->clip_bottom = (int64_t)context->config.height;
    } else if (command->opcode == PX_OP_SET_REMAP) {
        state->remap[(uint8_t)command->args[0]] = (uint8_t)command->args[1];
    } else if (command->opcode == PX_OP_RESET_REMAP) {
        px_identity_remap(state);
    }
}

void px_apply_palette(px_context *context, const px_command *command) {
    uint8_t *entry = context->palette + (size_t)command->args[0] * 4;
    entry[0] = (uint8_t)command->args[1];
    entry[1] = (uint8_t)command->args[2];
    entry[2] = (uint8_t)command->args[3];
    entry[3] = 255;
}

static px_region px_command_region(const px_context *context, const px_draw_state *state,
                                   const px_command *command, const px_resource_slot *resource) {
    if (command->opcode == PX_OP_CLEAR) {
        return (px_region){0, 0, (int64_t)context->config.width, (int64_t)context->config.height};
    }
    const int64_t x = (int64_t)command->args[0] - state->camera_x;
    const int64_t y = (int64_t)command->args[1] - state->camera_y;
    if (command->opcode == PX_OP_PIXEL) {
        return px_clip_box(state, x, y, x + 1, y + 1);
    }
    const int64_t width = command->args[command->opcode == PX_OP_BLIT ? 4 : 2];
    const int64_t height = command->args[command->opcode == PX_OP_BLIT ? 5 : 3];
    px_region region = px_clip_box(state, x, y, x + width, y + height);
    if (resource != NULL && command->opcode == PX_OP_BLIT) {
        const int64_t source_x = command->args[2];
        const int64_t source_y = command->args[3];
        const bool flip_x = (command->flags & PX_FLAG_FLIP_X) != 0;
        const bool flip_y = (command->flags & PX_FLAG_FLIP_Y) != 0;
        const int64_t source_left = flip_x ? source_x + width - (int64_t)resource->width : -source_x;
        const int64_t source_right = flip_x ? source_x + width : (int64_t)resource->width - source_x;
        const int64_t source_top = flip_y ? source_y + height - (int64_t)resource->height : -source_y;
        const int64_t source_bottom =
            flip_y ? source_y + height : (int64_t)resource->height - source_y;
        region.left = px_max_i64(region.left, x + source_left);
        region.right = px_min_i64(region.right, x + source_right);
        region.top = px_max_i64(region.top, y + source_top);
        region.bottom = px_min_i64(region.bottom, y + source_bottom);
    }
    return px_region_empty(region) ? px_empty_region : region;
}

static px_region px_circle_region(const px_draw_state *state, const px_command *command) {
    const int64_t x = (int64_t)command->args[0] - state->camera_x;
    const int64_t y = (int64_t)command->args[1] - state->camera_y;
    const int64_t radius = command->args[2];
    return px_clip_box(state, x - radius, y - radius, x + radius + 1, y + radius + 1);
}

static void px_glyph_size(const px_resource_slot *font, int64_t *out_width, int64_t *out_height) {
    *out_width = font != NULL ? (int64_t)font->width : (int64_t)PX_BUILTIN_GLYPH_SIZE;
    *out_height = font != NULL ? (int64_t)font->height : (int64_t)PX_BUILTIN_GLYPH_SIZE;
}

/* Cells of a TILEMAP command that intersect the clip, as half-open ranges of
 * map columns/rows. Drawing and work estimation share this definition. */
typedef struct px_tile_span {
    int64_t first_column;
    int64_t end_column;
    int64_t first_row;
    int64_t end_row;
} px_tile_span;

static void px_visible_cells(int64_t origin, int64_t clip_start, int64_t clip_end, int64_t size,
                             int64_t first, int64_t count, int64_t limit, int64_t *out_first,
                             int64_t *out_end) {
    int64_t visible_first = first;
    if (origin < clip_start) {
        visible_first += (clip_start - origin) / size;
    }
    int64_t visible_end = first;
    if (clip_end > origin) {
        visible_end += (clip_end - origin + size - 1) / size;
    }
    visible_end = px_min_i64(visible_end, px_min_i64(first + count, limit));
    *out_first = visible_first;
    *out_end = px_max_i64(visible_first, visible_end);
}

static px_tile_span px_tilemap_span(const px_draw_state *state, const px_command *command,
                                    const px_resource_slot *map) {
    px_tile_span span;
    px_visible_cells((int64_t)command->args[0] - state->camera_x, state->clip_left,
                     state->clip_right, map->as.tilemap.tile_width, command->args[2],
                     command->args[4], map->width, &span.first_column, &span.end_column);
    px_visible_cells((int64_t)command->args[1] - state->camera_y, state->clip_top,
                     state->clip_bottom, map->as.tilemap.tile_height, command->args[3],
                     command->args[5], map->height, &span.first_row, &span.end_row);
    /* An empty clip selects no cells: a zero-width clip inside a tile would
     * otherwise select that tile's column and walk its rows with nothing to
     * draw. An empty axis empties both, so no row is visited without cells. */
    if (state->clip_right <= state->clip_left || state->clip_bottom <= state->clip_top ||
        span.end_column == span.first_column || span.end_row == span.first_row) {
        span.end_column = span.first_column;
        span.end_row = span.first_row;
    }
    return span;
}

/* Fixed per-row costs: an ellipse row takes up to three integer square roots,
 * a triangle row three 128-bit edge divisions. */
#define PX_ELLIPSE_ROW_WORK UINT64_C(128)
#define PX_TRIANGLE_ROW_WORK UINT64_C(256)
/* A flood fill visits each clip pixel at most a bounded number of times. */
#define PX_FILL_PIXEL_WORK UINT64_C(10)
/* A transformed sprite maps each destination pixel back through a rotation
 * and a scale, about 2.5 times the time of a plain sprite pixel (B05), so a
 * batch of them at the budget takes about as long as one of plain sprites. */
#define PX_TRANSFORM_PIXEL_WORK UINT64_C(3)

/* A clipped segment stays inside its clipped bounding box: one step per
 * major-axis pixel. */
static uint64_t px_line_work(const px_draw_state *state, int64_t x0, int64_t y0, int64_t x1,
                             int64_t y1) {
    const px_region region = px_clip_box(state, px_min_i64(x0, x1), px_min_i64(y0, y1),
                                         px_max_i64(x0, x1) + 1, px_max_i64(y0, y1) + 1);
    return (uint64_t)px_max_i64(region.right - region.left, region.bottom - region.top);
}

/* Camera-relative triangle vertices from args. */
static void px_triangle_vertices(const px_draw_state *state, const px_command *command,
                                 int64_t xs[3], int64_t ys[3]) {
    for (size_t index = 0; index < 3; ++index) {
        xs[index] = (int64_t)command->args[index * 2] - state->camera_x;
        ys[index] = (int64_t)command->args[index * 2 + 1] - state->camera_y;
    }
}

static px_region px_triangle_region(const px_draw_state *state, const int64_t xs[3],
                                    const int64_t ys[3]) {
    return px_clip_box(state, px_min_i64(xs[0], px_min_i64(xs[1], xs[2])),
                       px_min_i64(ys[0], px_min_i64(ys[1], ys[2])),
                       px_max_i64(xs[0], px_max_i64(xs[1], xs[2])) + 1,
                       px_max_i64(ys[0], px_max_i64(ys[1], ys[2])) + 1);
}

static int32_t px_sine(uint32_t angle) {
    const uint32_t step = angle & 1023U;
    switch ((angle >> 10) & 3U) {
    case 0:
        return px_quarter_sine[step];
    case 1:
        return px_quarter_sine[1024U - step];
    case 2:
        return -px_quarter_sine[step];
    default:
        return -px_quarter_sine[1024U - step];
    }
}

static int32_t px_cosine(uint32_t angle) {
    return px_sine((angle + 1024U) & 4095U);
}

/* Destination pixels a rotated and scaled sprite can touch: its
 * rectangle turned about its center, rounded outward with a margin. */
static px_region px_transform_region(const px_draw_state *state, const px_command *command) {
    const int64_t width = command->args[4];
    const int64_t height = command->args[5];
    if (width == 0 || height == 0) {
        return px_empty_region;
    }
    const uint64_t sine = (uint64_t)px_magnitude(px_sine((uint32_t)command->params[0]));
    const uint64_t cosine = (uint64_t)px_magnitude(px_cosine((uint32_t)command->params[0]));
    const uint64_t scale = (uint32_t)command->params[1];
    /* Half extents in doubled pixels: scale (Q16) x rotation (Q16) >> 32. */
    const int64_t half_x =
        (int64_t)(((cosine * (uint64_t)width + sine * (uint64_t)height) * scale) >> 32) + 4;
    const int64_t half_y =
        (int64_t)(((sine * (uint64_t)width + cosine * (uint64_t)height) * scale) >> 32) + 4;
    const int64_t center_x = 2 * ((int64_t)command->args[0] - state->camera_x) + width;
    const int64_t center_y = 2 * ((int64_t)command->args[1] - state->camera_y) + height;
    return px_clip_box(state, (center_x - half_x) / 2 - 1, (center_y - half_y) / 2 - 1,
                       (center_x + half_x) / 2 + 2, (center_y + half_y) / 2 + 2);
}

uint64_t px_command_work(const px_context *context, const px_draw_state *state,
                         const px_command *command, const px_resource_slot *resource) {
    switch (command->opcode) {
    case PX_OP_LINE:
        return px_line_work(state, (int64_t)command->args[0] - state->camera_x,
                            (int64_t)command->args[1] - state->camera_y,
                            (int64_t)command->args[2] - state->camera_x,
                            (int64_t)command->args[3] - state->camera_y);
    case PX_OP_TRIANGLE:
    case PX_OP_TRIANGLE_FILL: {
        int64_t xs[3];
        int64_t ys[3];
        px_triangle_vertices(state, command, xs, ys);
        uint64_t work = 0;
        for (size_t edge = 0; edge < 3; ++edge) {
            work += px_line_work(state, xs[edge], ys[edge], xs[(edge + 1) % 3], ys[(edge + 1) % 3]);
        }
        if (command->opcode == PX_OP_TRIANGLE_FILL) {
            const px_region region = px_triangle_region(state, xs, ys);
            if (!px_region_empty(region)) {
                work += px_region_area(region) +
                        PX_TRIANGLE_ROW_WORK * (uint64_t)(region.bottom - region.top);
            }
        }
        return work;
    }
    case PX_OP_ELLIPSE:
    case PX_OP_ELLIPSE_FILL: {
        const px_region region = px_command_region(context, state, command, NULL);
        return px_region_empty(region)
                   ? 0
                   : px_region_area(region) +
                         PX_ELLIPSE_ROW_WORK * (uint64_t)(region.bottom - region.top);
    }
    case PX_OP_FILL: {
        const int64_t x = (int64_t)command->args[0] - state->camera_x;
        const int64_t y = (int64_t)command->args[1] - state->camera_y;
        if (x < state->clip_left || x >= state->clip_right || y < state->clip_top ||
            y >= state->clip_bottom) {
            return 0;
        }
        const px_region clip = {state->clip_left, state->clip_top, state->clip_right,
                                state->clip_bottom};
        return PX_FILL_PIXEL_WORK * px_region_area(clip);
    }
    case PX_OP_BLIT_TRANSFORM:
        return PX_TRANSFORM_PIXEL_WORK * px_region_area(px_transform_region(state, command));
    case PX_OP_RECTB: {
        const px_region region = px_command_region(context, state, command, NULL);
        return 2 * (uint64_t)((region.right - region.left) + (region.bottom - region.top));
    }
    case PX_OP_CIRCLE:
    case PX_OP_CIRCLE_FILL: {
        const px_region region = px_circle_region(state, command);
        if (px_region_empty(region)) {
            return 0;
        }
        /* The midpoint loop runs about radius / sqrt(2) times regardless of
         * clipping, so a huge radius is admitted only within the batch budget. */
        const uint64_t iterations = (uint64_t)command->args[2] + 1;
        return command->opcode == PX_OP_CIRCLE ? 8 * iterations
                                               : px_region_area(region) + 4 * iterations;
    }
    case PX_OP_GLYPH: {
        int64_t width = 0;
        int64_t height = 0;
        px_glyph_size(resource, &width, &height);
        const int64_t x = (int64_t)command->args[0] - state->camera_x;
        const int64_t y = (int64_t)command->args[1] - state->camera_y;
        return px_region_area(px_clip_box(state, x, y, x + width, y + height));
    }
    case PX_OP_TILEMAP: {
        const int64_t x = (int64_t)command->args[0] - state->camera_x;
        const int64_t y = (int64_t)command->args[1] - state->camera_y;
        const px_region region =
            px_clip_box(state, x, y, x + (int64_t)command->args[4] * resource->as.tilemap.tile_width,
                        y + (int64_t)command->args[5] * resource->as.tilemap.tile_height);
        const px_tile_span span = px_tilemap_span(state, command, resource);
        const uint64_t cells = (uint64_t)(span.end_column - span.first_column) *
                               (uint64_t)(span.end_row - span.first_row);
        return px_region_area(region) + cells;
    }
    default:
        return px_region_area(px_command_region(context, state, command, resource));
    }
}

static inline void px_plot_pixel(px_context *context, const px_draw_state *state, int64_t x,
                                 int64_t y, uint8_t color) {
    if (x >= state->clip_left && x < state->clip_right && y >= state->clip_top &&
        y < state->clip_bottom) {
        context->frame[(size_t)y * context->config.width + (size_t)x] = color;
    }
}

/* Inclusive span [x0, x1] on row y, clipped before writing. Returns the
 * number of pixels written. */
static uint64_t px_plot_hline(px_context *context, const px_draw_state *state, int64_t y,
                              int64_t x0, int64_t x1, uint8_t color) {
    if (y < state->clip_top || y >= state->clip_bottom) {
        return 0;
    }
    const int64_t left = px_max_i64(x0, state->clip_left);
    const int64_t right = px_min_i64(x1 + 1, state->clip_right);
    if (right <= left) {
        return 0;
    }
    memset(context->frame + (size_t)y * context->config.width + (size_t)left, color,
           (size_t)(right - left));
    return (uint64_t)(right - left);
}

/* floor((factor * multiplier + addend) / divisor) and its remainder, for
 * operands below 2^35 and a quotient below 2^35. The product can need 70
 * bits, so it uses portable 128-bit long multiplication and division. */
static uint64_t px_divide_product(uint64_t factor, uint64_t multiplier, uint64_t addend,
                                  uint64_t divisor, uint64_t *out_remainder) {
    const uint64_t a_low = factor & UINT32_MAX;
    const uint64_t a_high = factor >> 32;
    const uint64_t b_low = multiplier & UINT32_MAX;
    const uint64_t b_high = multiplier >> 32;
    const uint64_t low_low = a_low * b_low;
    const uint64_t high_low = a_high * b_low;
    const uint64_t middle = (low_low >> 32) + (high_low & UINT32_MAX) + a_low * b_high;
    uint64_t high = a_high * b_high + (high_low >> 32) + (middle >> 32);
    uint64_t low = (middle << 32) | (low_low & UINT32_MAX);
    low += addend;
    high += low < addend ? 1U : 0U;
    if (high == 0) {
        *out_remainder = low % divisor;
        return low / divisor;
    }
    /* high < divisor because the quotient fits, so the remainder stays below
     * 2^36 and the shift never overflows. */
    uint64_t remainder = high;
    uint64_t quotient = 0;
    for (int bit = 63; bit >= 0; --bit) {
        remainder = (remainder << 1) | ((low >> bit) & 1U);
        quotient <<= 1;
        if (remainder >= divisor) {
            remainder -= divisor;
            quotient |= 1U;
        }
    }
    *out_remainder = remainder;
    return quotient;
}

/* All-octant Bresenham from (x0, y0) to (x1, y1), drawing only the pixels
 * inside the clip. Every step advances the major axis by one, and pixel k
 * lies at minor offset floor((2 * minor * k + major) / (2 * major)), so the
 * walk starts directly at the first visible column or row with the error
 * term it would have reached there. Clipping, the camera and the canvas
 * size therefore never move a pixel of the line. */
static uint64_t px_raster_line(px_context *context, const px_draw_state *state, int64_t x0,
                               int64_t y0, int64_t x1, int64_t y1, uint8_t color) {
    const px_region region = px_clip_box(state, px_min_i64(x0, x1), px_min_i64(y0, y1),
                                         px_max_i64(x0, x1) + 1, px_max_i64(y0, y1) + 1);
    if (px_region_empty(region)) {
        return 0;
    }
    const int64_t dx = x1 > x0 ? x1 - x0 : x0 - x1;
    const int64_t dy = y1 > y0 ? y0 - y1 : y1 - y0;
    const int64_t step_x = x0 < x1 ? 1 : -1;
    const int64_t step_y = y0 < y1 ? 1 : -1;
    const bool x_major = dx >= -dy;
    const int64_t major = x_major ? dx : -dy;
    const int64_t minor = x_major ? -dy : dx;
    /* First and last major steps inside the region, which lies within the
     * line's bounding box, so 0 <= first <= last <= major. */
    const int64_t origin = x_major ? x0 : y0;
    const int64_t low = x_major ? region.left : region.top;
    const int64_t high = (x_major ? region.right : region.bottom) - 1;
    const bool forward = (x_major ? step_x : step_y) > 0;
    const int64_t first = forward ? low - origin : origin - high;
    const int64_t last = forward ? high - origin : origin - low;
    int64_t offset = 0;
    int64_t error = dx + dy;
    if (first > 0) {
        uint64_t remainder = 0;
        offset = (int64_t)px_divide_product(2 * (uint64_t)minor, (uint64_t)first,
                                            (uint64_t)major, 2 * (uint64_t)major, &remainder);
        /* The walk keeps error = dx * (y steps + 1) + dy * (x steps + 1);
         * remainder has the parity of major, so the halving is exact. */
        const int64_t half = (3 * major - (int64_t)remainder) / 2;
        error = x_major ? half + dy : dx - half;
    }
    int64_t x = x0 + step_x * (x_major ? first : offset);
    int64_t y = y0 + step_y * (x_major ? offset : first);
    /* One iteration per major step inside the region: the work estimate. */
    for (int64_t remaining = last - first;; --remaining) {
        px_plot_pixel(context, state, x, y, color);
        if (remaining == 0) {
            return (uint64_t)(last - first + 1);
        }
        const int64_t doubled = 2 * error;
        if (doubled >= dy) {
            error += dy;
            x += step_x;
        }
        if (doubled <= dx) {
            error += dx;
            y += step_y;
        }
    }
}

static uint64_t px_raster_rectb(px_context *context, const px_draw_state *state, int64_t x,
                                int64_t y, int64_t width, int64_t height, uint8_t color) {
    /* An outline whose box misses the clip is estimated at zero work, so its
     * sides must not walk the clip rows either. */
    if (width <= 0 || height <= 0 ||
        px_region_empty(px_clip_box(state, x, y, x + width, y + height))) {
        return 0;
    }
    const int64_t right = x + width - 1;
    const int64_t bottom = y + height - 1;
    uint64_t work = px_plot_hline(context, state, y, x, right, color);
    if (height > 1) {
        work += px_plot_hline(context, state, bottom, x, right, color);
    }
    /* Visit only rows inside the clip; the sides are single pixels. */
    const int64_t first_row = px_max_i64(y + 1, state->clip_top);
    const int64_t end_row = px_min_i64(bottom, state->clip_bottom);
    for (int64_t row = first_row; row < end_row; ++row) {
        px_plot_pixel(context, state, x, row, color);
        if (width > 1) {
            px_plot_pixel(context, state, right, row, color);
        }
        work += 2;
    }
    return work;
}

static uint64_t px_raster_circle(px_context *context, const px_draw_state *state, int64_t cx,
                                 int64_t cy, int64_t radius, uint8_t color) {
    int64_t x = 0;
    int64_t y = radius;
    int64_t decision = 1 - radius;
    while (x <= y) {
        px_plot_pixel(context, state, cx + x, cy + y, color);
        px_plot_pixel(context, state, cx - x, cy + y, color);
        px_plot_pixel(context, state, cx + x, cy - y, color);
        px_plot_pixel(context, state, cx - x, cy - y, color);
        px_plot_pixel(context, state, cx + y, cy + x, color);
        px_plot_pixel(context, state, cx - y, cy + x, color);
        px_plot_pixel(context, state, cx + y, cy - x, color);
        px_plot_pixel(context, state, cx - y, cy - x, color);
        if (decision < 0) {
            decision += 2 * x + 3;
        } else {
            decision += 2 * (x - y) + 5;
            --y;
        }
        ++x;
    }
    return 8 * (uint64_t)x;
}

/* Same midpoint boundary as the outline. Rows at distance x are drawn every
 * step; rows at distance y only once, just before y changes, when their span
 * is widest. The two sets never meet, so each row is written exactly once. */
static uint64_t px_raster_circle_fill(px_context *context, const px_draw_state *state,
                                      int64_t cx, int64_t cy, int64_t radius, uint8_t color) {
    int64_t x = 0;
    int64_t y = radius;
    int64_t decision = 1 - radius;
    uint64_t written = 0;
    while (x <= y) {
        written += px_plot_hline(context, state, cy + x, cx - y, cx + y, color);
        if (x != 0) {
            written += px_plot_hline(context, state, cy - x, cx - y, cx + y, color);
        }
        if (decision < 0) {
            decision += 2 * x + 3;
        } else {
            if (x != y) {
                written += px_plot_hline(context, state, cy + y, cx - x, cx + x, color);
                written += px_plot_hline(context, state, cy - y, cx - x, cx + x, color);
            }
            decision += 2 * (x - y) + 5;
            --y;
        }
        ++x;
    }
    /* At most four spans per step; the spans cover the circle once. */
    return 4 * (uint64_t)x + written;
}

static uint64_t px_raster_glyph(px_context *context, const px_draw_state *state,
                                const px_command *command, const px_resource_slot *font) {
    const int64_t left = (int64_t)command->args[0] - state->camera_x;
    const int64_t top = (int64_t)command->args[1] - state->camera_y;
    const uint32_t code = (uint32_t)command->args[2];
    const uint8_t color = px_ink(state, command->args[3]);
    const int32_t background = command->args[4] >= 0 ? px_ink(state, command->args[4]) : -1;
    int64_t width = 0;
    int64_t height = 0;
    px_glyph_size(font, &width, &height);
    const px_region region = px_clip_box(state, left, top, left + width, top + height);
    if (px_region_empty(region)) {
        return 0;
    }
    const uint8_t *bitmap = NULL;
    size_t row_bytes = 1;
    if (font == NULL) {
        /* Built-in original 8x8 ASCII glyphs; entry 95 is the fallback box. */
        bitmap = px_font_8x8[code >= 32 && code <= 126 ? code - 32 : 95];
    } else {
        const px_font_info *info = &font->as.font;
        const uint32_t glyph = code >= info->first_char && code - info->first_char < info->char_count
                                   ? code - info->first_char
                                   : info->fallback_glyph;
        row_bytes = info->row_bytes;
        bitmap = font->storage + PX_HEADER_BYTES + (size_t)glyph * row_bytes * font->height;
    }
    for (int64_t y = region.top; y < region.bottom; ++y) {
        const uint8_t *row = bitmap + (size_t)(y - top) * row_bytes;
        uint8_t *target = context->frame + (size_t)y * context->config.width;
        for (int64_t x = region.left; x < region.right; ++x) {
            const size_t column = (size_t)(x - left);
            if (((row[column / 8] >> (7 - column % 8)) & 1U) != 0) {
                target[x] = color;
            } else if (background >= 0) {
                target[x] = (uint8_t)background;
            }
        }
    }
    return px_region_area(region);
}

static uint64_t px_raster_tilemap(px_context *context, const px_draw_state *state,
                                  const px_command *command, const px_resource_slot *map) {
    const px_resource_slot *tileset = px_find_image(context, map->as.tilemap.tileset);
    if (tileset == NULL) {
        return 0; /* Unreachable: a mapped image cannot be released. */
    }
    const int64_t origin_x = (int64_t)command->args[0] - state->camera_x;
    const int64_t origin_y = (int64_t)command->args[1] - state->camera_y;
    const int64_t tile_width = map->as.tilemap.tile_width;
    const int64_t tile_height = map->as.tilemap.tile_height;
    const uint32_t tiles_per_row = map->as.tilemap.tiles_per_row;
    const uint8_t *cells = map->storage + PX_HEADER_BYTES;
    const uint8_t *pixels = tileset->storage + PX_HEADER_BYTES;
    const px_tile_span span = px_tilemap_span(state, command, map);
    uint64_t work = (uint64_t)(span.end_column - span.first_column) *
                    (uint64_t)(span.end_row - span.first_row);
    for (int64_t row = span.first_row; row < span.end_row; ++row) {
        const int64_t cell_top = origin_y + (row - command->args[3]) * tile_height;
        const int64_t first_y = px_max_i64(cell_top, state->clip_top);
        const int64_t end_y = px_min_i64(cell_top + tile_height, state->clip_bottom);
        for (int64_t column = span.first_column; column < span.end_column; ++column) {
            const uint32_t tile =
                px_read_u16(cells + ((size_t)row * map->width + (size_t)column) * 2);
            if (tile == PX_EMPTY_TILE) {
                continue;
            }
            /* Commit validated every ID, so the whole tile lies in the tileset. */
            const size_t source_x = (size_t)(tile % tiles_per_row) * (size_t)tile_width;
            const size_t source_y = (size_t)(tile / tiles_per_row) * (size_t)tile_height;
            const int64_t cell_left = origin_x + (column - command->args[2]) * tile_width;
            const int64_t first_x = px_max_i64(cell_left, state->clip_left);
            const int64_t end_x = px_min_i64(cell_left + tile_width, state->clip_right);
            /* Every visited cell overlaps the clip, so no row is walked in vain. */
            assert(first_x < end_x && first_y < end_y);
            work += (uint64_t)(end_x - first_x) * (uint64_t)(end_y - first_y);
            for (int64_t y = first_y; y < end_y; ++y) {
                const uint8_t *source =
                    pixels + (source_y + (size_t)(y - cell_top)) * tileset->width + source_x;
                uint8_t *target = context->frame + (size_t)y * context->config.width;
                for (int64_t x = first_x; x < end_x; ++x) {
                    const uint8_t color = source[x - cell_left];
                    if ((uint32_t)color != tileset->as.image.transparency) {
                        target[x] = state->remap[color];
                    }
                }
            }
        }
    }
    return work;
}

static uint64_t px_raster_blit(px_context *context, const px_draw_state *state,
                               const px_command *command, const px_resource_slot *image,
                               px_region region) {
    const int64_t destination_x = (int64_t)command->args[0] - state->camera_x;
    const int64_t destination_y = (int64_t)command->args[1] - state->camera_y;
    const uint8_t *pixels = image->storage + PX_HEADER_BYTES;
    for (int64_t y = region.top; y < region.bottom; ++y) {
        const int64_t relative_y = y - destination_y;
        const int64_t source_y =
            (int64_t)command->args[3] + ((command->flags & PX_FLAG_FLIP_Y) != 0
                                             ? (int64_t)command->args[5] - 1 - relative_y
                                             : relative_y);
        for (int64_t x = region.left; x < region.right; ++x) {
            const int64_t relative_x = x - destination_x;
            const int64_t source_x =
                (int64_t)command->args[2] + ((command->flags & PX_FLAG_FLIP_X) != 0
                                                 ? (int64_t)command->args[4] - 1 - relative_x
                                                 : relative_x);
            const uint8_t color = pixels[(size_t)source_y * image->width + (size_t)source_x];
            if ((uint32_t)color != image->as.image.transparency) {
                context->frame[(size_t)y * context->config.width + (size_t)x] =
                    state->remap[color];
            }
        }
    }
    return px_region_area(region);
}

/* floor(sqrt(value)), digit by digit: at most 32 iterations. */
static uint64_t px_isqrt(uint64_t value) {
    uint64_t root = 0;
    uint64_t bit = UINT64_C(1) << 62;
    while (bit > value) {
        bit >>= 2;
    }
    while (bit != 0) {
        if (value >= root + bit) {
            value -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    return root;
}

/* Columns [*first, *last] of row `row` inside the ellipse inscribed in a
 * width x height box: pixel (i, j) is inside when its center satisfies
 * ((2i + 1 - w) / w)^2 + ((2j + 1 - h) / h)^2 <= 1. Sizes are at most 2^14,
 * so every product fits in 64 bits. */
static bool px_ellipse_span(int64_t width, int64_t height, int64_t row, int64_t *first,
                            int64_t *last) {
    if (row < 0 || row >= height) {
        return false;
    }
    const int64_t offset = 2 * row + 1 - height;
    const uint64_t reach =
        (uint64_t)(width * width) * (uint64_t)(height * height - offset * offset);
    /* |2i + 1 - w| has the parity of w + 1. */
    int64_t half = (int64_t)(px_isqrt(reach) / (uint64_t)height);
    if (((half ^ (width + 1)) & 1) != 0) {
        --half;
    }
    if (half < 0) {
        return false;
    }
    *first = (width - 1 - half) / 2;
    *last = (width - 1 + half) / 2;
    return true;
}

/* Filled ellipses draw every inside pixel; outlines draw the inside pixels
 * that have a 4-neighbour outside, so an outline is the fill's boundary. */
static uint64_t px_raster_ellipse(px_context *context, const px_draw_state *state, int64_t x,
                                  int64_t y, int64_t width, int64_t height, uint8_t color,
                                  bool filled) {
    const px_region region = px_clip_box(state, x, y, x + width, y + height);
    if (width <= 0 || height <= 0 || px_region_empty(region)) {
        return 0;
    }
    uint64_t work = 0;
    for (int64_t py = region.top; py < region.bottom; ++py) {
        const int64_t row = py - y;
        int64_t first = 0;
        int64_t last = 0;
        work += PX_ELLIPSE_ROW_WORK;
        if (!px_ellipse_span(width, height, row, &first, &last)) {
            continue;
        }
        if (filled) {
            work += px_plot_hline(context, state, py, x + first, x + last, color);
            continue;
        }
        int64_t inner_first = first + 1;
        int64_t inner_last = last - 1;
        for (int64_t neighbour = row - 1; neighbour <= row + 1; neighbour += 2) {
            int64_t other_first = 0;
            int64_t other_last = 0;
            if (!px_ellipse_span(width, height, neighbour, &other_first, &other_last)) {
                inner_last = inner_first - 1;
                break;
            }
            inner_first = px_max_i64(inner_first, other_first);
            inner_last = px_min_i64(inner_last, other_last);
        }
        if (inner_first > inner_last) {
            work += px_plot_hline(context, state, py, x + first, x + last, color);
        } else {
            work += px_plot_hline(context, state, py, x + first, x + inner_first - 1, color);
            work += px_plot_hline(context, state, py, x + inner_last + 1, x + last, color);
        }
    }
    return work;
}

/* Signed two's-complement 128-bit value for exact triangle edge functions. */
typedef struct px_wide {
    uint64_t high;
    uint64_t low;
} px_wide;

static bool px_wide_negative(px_wide value) {
    return (value.high >> 63) != 0;
}

static px_wide px_wide_negate(px_wide value) {
    const px_wide result = {~value.high + (value.low == 0 ? 1U : 0U), ~value.low + 1U};
    return result;
}

static px_wide px_wide_multiply(int64_t left, int64_t right) {
    const uint64_t a = px_magnitude(left);
    const uint64_t b = px_magnitude(right);
    const uint64_t low_low = (a & UINT32_MAX) * (b & UINT32_MAX);
    const uint64_t low_high = (a & UINT32_MAX) * (b >> 32);
    const uint64_t high_low = (a >> 32) * (b & UINT32_MAX);
    const uint64_t middle = (low_low >> 32) + (low_high & UINT32_MAX) + (high_low & UINT32_MAX);
    const px_wide product = {(a >> 32) * (b >> 32) + (low_high >> 32) + (high_low >> 32) +
                                 (middle >> 32),
                             (middle << 32) | (low_low & UINT32_MAX)};
    return (left < 0) != (right < 0) ? px_wide_negate(product) : product;
}

static px_wide px_wide_subtract(px_wide left, px_wide right) {
    const px_wide result = {left.high - right.high - (left.low < right.low ? 1U : 0U),
                            left.low - right.low};
    return result;
}

/* floor(value / divisor) for divisor > 0, saturated to +-2^40, far beyond
 * any coordinate a clip can hold. */
static int64_t px_wide_floor_divide(px_wide value, uint64_t divisor) {
    const int64_t limit = INT64_C(1) << 40;
    const bool negative = px_wide_negative(value);
    const px_wide magnitude = negative ? px_wide_negate(value) : value;
    if (magnitude.high >= divisor) {
        return negative ? -limit : limit;
    }
    uint64_t quotient = 0;
    uint64_t remainder = 0;
    if (magnitude.high == 0) {
        quotient = magnitude.low / divisor;
        remainder = magnitude.low % divisor;
    } else {
        /* high < divisor < 2^36, so the remainder never overflows. */
        remainder = magnitude.high;
        for (int bit = 63; bit >= 0; --bit) {
            remainder = (remainder << 1) | ((magnitude.low >> bit) & 1U);
            quotient <<= 1;
            if (remainder >= divisor) {
                remainder -= divisor;
                quotient |= 1U;
            }
        }
    }
    if (quotient >= (uint64_t)limit) {
        return negative ? -limit : limit;
    }
    const int64_t result = (int64_t)quotient;
    return negative ? -result - (remainder != 0 ? 1 : 0) : result;
}

/* Outlines are the three exact lines. Fills add every pixel whose center
 * lies inside or on the triangle, so a fill always covers its outline. */
static uint64_t px_raster_triangle(px_context *context, const px_draw_state *state,
                                   const int64_t xs[3], const int64_t ys[3], uint8_t color,
                                   bool filled) {
    uint64_t work = 0;
    for (size_t edge = 0; edge < 3; ++edge) {
        const size_t next = (edge + 1) % 3;
        work += px_raster_line(context, state, xs[edge], ys[edge], xs[next], ys[next], color);
    }
    const px_region region = px_triangle_region(state, xs, ys);
    if (!filled || px_region_empty(region)) {
        return work;
    }
    const px_wide area = px_wide_subtract(px_wide_multiply(xs[1] - xs[0], ys[2] - ys[0]),
                                          px_wide_multiply(ys[1] - ys[0], xs[2] - xs[0]));
    if (area.high == 0 && area.low == 0) {
        return work; /* Collinear: the edges are the whole triangle. */
    }
    const bool flip = px_wide_negative(area);
    for (int64_t py = region.top; py < region.bottom; ++py) {
        work += PX_TRIANGLE_ROW_WORK;
        int64_t left = region.left;
        int64_t right = region.right - 1;
        /* Doubled edge function at pixel centers: E(px) = c - k * px. */
        for (size_t edge = 0; edge < 3 && left <= right; ++edge) {
            const size_t next = (edge + 1) % 3;
            const int64_t ax = xs[edge];
            const int64_t ay = ys[edge];
            px_wide c = px_wide_subtract(px_wide_multiply(xs[next] - ax, 2 * py + 1 - 2 * ay),
                                         px_wide_multiply(ys[next] - ay, 1 - 2 * ax));
            int64_t k = 2 * (ys[next] - ay);
            if (flip) {
                c = px_wide_negate(c);
                k = -k;
            }
            if (k == 0) {
                if (px_wide_negative(c)) {
                    right = left - 1;
                }
            } else if (k > 0) {
                right = px_min_i64(right, px_wide_floor_divide(c, (uint64_t)k));
            } else {
                left = px_max_i64(left, -px_wide_floor_divide(c, px_magnitude(k)));
            }
        }
        if (left <= right) {
            work += px_plot_hline(context, state, py, left, right, color);
        }
    }
    return work;
}

/* 4-connected flood fill of the seed pixel's color, confined to the clip.
 * Each pushed seed is painted when pushed, so no pixel is pushed twice and
 * the stack never holds more entries than the framebuffer has pixels. */
static uint64_t px_raster_fill(px_context *context, const px_draw_state *state, int64_t x,
                               int64_t y, uint8_t color) {
    if (x < state->clip_left || x >= state->clip_right || y < state->clip_top ||
        y >= state->clip_bottom) {
        return 0;
    }
    const int64_t width = (int64_t)context->config.width;
    uint8_t *frame = context->frame;
    const uint8_t target = frame[y * width + x];
    if (target == color) {
        return 1;
    }
    uint32_t *stack = context->fill_stack;
    size_t top = 0;
    stack[top++] = (uint32_t)(y * width + x);
    frame[y * width + x] = color;
    uint64_t work = 0;
    while (top > 0) {
        const uint32_t seed = stack[--top];
        const int64_t row = (int64_t)(seed / (uint32_t)width);
        uint8_t *pixels = frame + row * width;
        int64_t left = (int64_t)(seed % (uint32_t)width);
        int64_t right = left;
        while (left > state->clip_left && pixels[left - 1] == target) {
            --left;
        }
        while (right + 1 < state->clip_right && pixels[right + 1] == target) {
            ++right;
        }
        memset(pixels + left, color, (size_t)(right - left + 1));
        work += 1 + 4 * (uint64_t)(right - left + 1);
        for (int64_t other = row - 1; other <= row + 1; other += 2) {
            if (other < state->clip_top || other >= state->clip_bottom) {
                continue;
            }
            uint8_t *next = frame + other * width;
            bool inside = false;
            for (int64_t column = left; column <= right; ++column) {
                if (next[column] != target) {
                    inside = false;
                } else if (!inside) {
                    inside = true;
                    next[column] = color;
                    assert(top < context->frame_bytes);
                    stack[top++] = (uint32_t)(other * width + column);
                }
            }
        }
    }
    return work;
}

static int64_t px_floor_shift(int64_t value, unsigned shift) {
    return value >= 0 ? value >> shift
                      : -(int64_t)((px_magnitude(value) + ((UINT64_C(1) << shift) - 1)) >> shift);
}

/* Rotation (1/4096 turns, clockwise on screen) and scale (Q16) about the
 * sprite's center. Each destination pixel center maps back to one source
 * pixel with integer arithmetic only, so every build draws the same pixels. */
static uint64_t px_raster_blit_transform(px_context *context, const px_draw_state *state,
                                         const px_command *command,
                                         const px_resource_slot *image) {
    const px_region region = px_transform_region(state, command);
    if (px_region_empty(region)) {
        return 0;
    }
    const int64_t width = command->args[4];
    const int64_t height = command->args[5];
    const int64_t center_x = 2 * ((int64_t)command->args[0] - state->camera_x) + width;
    const int64_t center_y = 2 * ((int64_t)command->args[1] - state->camera_y) + height;
    const int64_t sine = px_sine((uint32_t)command->params[0]);
    const int64_t cosine = px_cosine((uint32_t)command->params[0]);
    const uint64_t scale = (uint32_t)command->params[1];
    const int64_t inverse = (int64_t)(((UINT64_C(1) << 32) + scale / 2) / scale);
    const bool flip_x = (command->flags & PX_FLAG_FLIP_X) != 0;
    const bool flip_y = (command->flags & PX_FLAG_FLIP_Y) != 0;
    const uint8_t *pixels = image->storage + PX_HEADER_BYTES;
    for (int64_t py = region.top; py < region.bottom; ++py) {
        const int64_t dy = 2 * py + 1 - center_y;
        uint8_t *target = context->frame + (size_t)py * context->config.width;
        for (int64_t px = region.left; px < region.right; ++px) {
            const int64_t dx = 2 * px + 1 - center_x;
            /* Inverse rotation, then inverse scale, in Q16 doubled pixels. */
            const int64_t u = ((cosine * dx + sine * dy) * inverse) >> 16;
            const int64_t v = ((cosine * dy - sine * dx) * inverse) >> 16;
            const int64_t column = px_floor_shift(u + width * 65536, 17);
            const int64_t line = px_floor_shift(v + height * 65536, 17);
            if (column < 0 || column >= width || line < 0 || line >= height) {
                continue;
            }
            const int64_t source_x =
                (int64_t)command->args[2] + (flip_x ? width - 1 - column : column);
            const int64_t source_y =
                (int64_t)command->args[3] + (flip_y ? height - 1 - line : line);
            const uint8_t color = pixels[(size_t)source_y * image->width + (size_t)source_x];
            if ((uint32_t)color != image->as.image.transparency) {
                target[px] = state->remap[color];
            }
        }
    }
    return PX_TRANSFORM_PIXEL_WORK * px_region_area(region);
}

uint64_t px_raster_command(px_context *context, const px_draw_state *state,
                           const px_command *command, const px_resource_slot *resource) {
    const int64_t x = (int64_t)command->args[0] - state->camera_x;
    const int64_t y = (int64_t)command->args[1] - state->camera_y;
    switch (command->opcode) {
    case PX_OP_LINE:
        return px_raster_line(context, state, x, y, (int64_t)command->args[2] - state->camera_x,
                              (int64_t)command->args[3] - state->camera_y,
                              px_ink(state, command->args[4]));
    case PX_OP_RECTB:
        return px_raster_rectb(context, state, x, y, command->args[2], command->args[3],
                               px_ink(state, command->args[4]));
    case PX_OP_CIRCLE:
    case PX_OP_CIRCLE_FILL:
        if (px_region_empty(px_circle_region(state, command))) {
            return 0;
        }
        return command->opcode == PX_OP_CIRCLE
                   ? px_raster_circle(context, state, x, y, command->args[2],
                                      px_ink(state, command->args[3]))
                   : px_raster_circle_fill(context, state, x, y, command->args[2],
                                           px_ink(state, command->args[3]));
    case PX_OP_ELLIPSE:
    case PX_OP_ELLIPSE_FILL:
        return px_raster_ellipse(context, state, x, y, command->args[2], command->args[3],
                                 px_ink(state, command->args[4]),
                                 command->opcode == PX_OP_ELLIPSE_FILL);
    case PX_OP_TRIANGLE:
    case PX_OP_TRIANGLE_FILL: {
        int64_t xs[3];
        int64_t ys[3];
        px_triangle_vertices(state, command, xs, ys);
        return px_raster_triangle(context, state, xs, ys, px_ink(state, command->params[0]),
                                  command->opcode == PX_OP_TRIANGLE_FILL);
    }
    case PX_OP_FILL:
        return px_raster_fill(context, state, x, y, px_ink(state, command->args[2]));
    case PX_OP_BLIT_TRANSFORM:
        return px_raster_blit_transform(context, state, command, resource);
    case PX_OP_GLYPH:
        return px_raster_glyph(context, state, command, resource);
    case PX_OP_TILEMAP:
        return px_raster_tilemap(context, state, command, resource);
    case PX_OP_BLIT:
        return px_raster_blit(context, state, command, resource,
                              px_command_region(context, state, command, resource));
    default:
        break;
    }
    const px_region region = px_command_region(context, state, command, resource);
    const uint8_t color = px_ink(state, command->args[command->opcode == PX_OP_CLEAR   ? 0
                                                     : command->opcode == PX_OP_PIXEL ? 2
                                                                                      : 4]);
    const size_t width = (size_t)(region.right - region.left);
    for (int64_t row = region.top; row < region.bottom; ++row) {
        memset(context->frame + (size_t)row * context->config.width + (size_t)region.left, color,
               width);
    }
    return px_region_area(region);
}
