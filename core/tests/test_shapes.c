#include "internal.h"
#include "trig_data.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Contracts for ellipses, triangles, flood fill, draw-time remapping and
 * rotated/scaled sprites. Every primitive is compared with an independent
 * per-pixel reference; debug builds also assert that no command exceeds
 * its admitted work. */

#define CHECK(expression)                                                                          \
    do {                                                                                           \
        if (!(expression)) {                                                                       \
            fprintf(stderr, "Check failed at %s:%d: %s\n", __FILE__, __LINE__, #expression);       \
            exit(EXIT_FAILURE);                                                                    \
        }                                                                                          \
    } while (0)

#if !defined(__SIZEOF_INT128__)
#error "The shape references need 128-bit integers (Clang or GCC)."
#endif
__extension__ typedef __int128 wide_int;
__extension__ typedef unsigned __int128 wide_uint;

#define WIDTH 24
#define HEIGHT 20

static void write_u32(uint8_t *bytes, uint32_t value) {
    for (size_t index = 0; index < 4; ++index) {
        bytes[index] = (uint8_t)(value >> (index * 8));
    }
}

static size_t batch_header(uint8_t *bytes, uint32_t count) {
    const size_t length = PX_HEADER_BYTES + (size_t)count * PX_RECORD_BYTES;
    memset(bytes, 0, length);
    memcpy(bytes, "PXJS", 4);
    write_u32(bytes + 4, PX_PROTOCOL_VERSION);
    write_u32(bytes + 8, count);
    write_u32(bytes + 12, (uint32_t)length);
    return length;
}

static void command(uint8_t *bytes, size_t index, uint16_t opcode, uint16_t flags, uint32_t handle,
                    int32_t a, int32_t b, int32_t c, int32_t d, int32_t e, int32_t f) {
    uint8_t *record = bytes + PX_HEADER_BYTES + index * PX_RECORD_BYTES;
    record[0] = (uint8_t)opcode;
    record[1] = (uint8_t)(opcode >> 8);
    record[2] = (uint8_t)flags;
    record[3] = (uint8_t)(flags >> 8);
    write_u32(record + 4, handle);
    const int32_t args[6] = {a, b, c, d, e, f};
    for (size_t arg = 0; arg < 6; ++arg) {
        write_u32(record + 8 + arg * 4, (uint32_t)args[arg]);
    }
}

static uint32_t random_u32(uint32_t *state) {
    uint32_t value = *state;
    value ^= value << 13;
    value ^= value >> 17;
    value ^= value << 5;
    *state = value;
    return value;
}

static int32_t random_range(uint32_t *state, int32_t low, int32_t high) {
    return low + (int32_t)(random_u32(state) % (uint32_t)(high - low + 1));
}

/* Half of the cases use the whole screen as clip, so most cases draw. */
static void random_clip(uint32_t *state, int32_t clip[4]) {
    if ((random_u32(state) & 1U) != 0) {
        clip[0] = 0;
        clip[1] = 0;
        clip[2] = WIDTH;
        clip[3] = HEIGHT;
        return;
    }
    clip[0] = random_range(state, -4, WIDTH - 1);
    clip[1] = random_range(state, -4, HEIGHT - 1);
    clip[2] = random_range(state, 0, WIDTH + 4);
    clip[3] = random_range(state, 0, HEIGHT + 4);
}

static size_t count_drawn(const uint8_t *frame) {
    size_t count = 0;
    for (size_t index = 0; index < WIDTH * HEIGHT; ++index) {
        count += frame[index] != 0 ? 1U : 0U;
    }
    return count;
}

static px_context *create_context(uint32_t width, uint32_t height) {
    px_context *context = NULL;
    const px_config config = {width, height, 16, PX_MEMORY_BUDGET_BYTES};
    CHECK(px_context_create(&config, NULL, &context) == PX_OK);
    return context;
}

/* Clip rectangle after SET_CLIP clamping, as [left, right) x [top, bottom). */
typedef struct clip_box {
    int64_t left;
    int64_t top;
    int64_t right;
    int64_t bottom;
} clip_box;

static clip_box clamp_clip(int32_t x, int32_t y, int32_t width, int32_t height) {
    const clip_box box = {x < 0 ? 0 : x, y < 0 ? 0 : y,
                          (int64_t)x + width > WIDTH ? WIDTH : (int64_t)x + width,
                          (int64_t)y + height > HEIGHT ? HEIGHT : (int64_t)y + height};
    return box;
}

static void plot(uint8_t *frame, const clip_box *clip, int64_t x, int64_t y, uint8_t color) {
    if (x >= clip->left && x < clip->right && y >= clip->top && y < clip->bottom) {
        frame[y * WIDTH + x] = color;
    }
}

/* The literal all-octant Bresenham walk, clipped per pixel. */
static void walk_line(uint8_t *frame, const clip_box *clip, int64_t x0, int64_t y0, int64_t x1,
                      int64_t y1, uint8_t color) {
    const int64_t dx = x1 > x0 ? x1 - x0 : x0 - x1;
    const int64_t dy = -(y1 > y0 ? y1 - y0 : y0 - y1);
    int64_t error = dx + dy;
    for (;;) {
        plot(frame, clip, x0, y0, color);
        if (x0 == x1 && y0 == y1) {
            return;
        }
        const int64_t doubled = 2 * error;
        if (doubled >= dy) {
            error += dy;
            x0 += x0 < x1 ? 1 : -1;
        }
        if (doubled <= dx) {
            error += dx;
            y0 += y0 < y1 ? 1 : -1;
        }
    }
}

static bool ellipse_inside(int64_t i, int64_t j, int64_t width, int64_t height) {
    if (i < 0 || j < 0 || i >= width || j >= height) {
        return false;
    }
    const int64_t dx = 2 * i + 1 - width;
    const int64_t dy = 2 * j + 1 - height;
    return dx * dx * height * height + dy * dy * width * width <= width * width * height * height;
}

static void reference_ellipse(uint8_t *frame, const clip_box *clip, int64_t x, int64_t y,
                              int64_t width, int64_t height, uint8_t color, bool filled) {
    for (int64_t j = 0; j < height; ++j) {
        for (int64_t i = 0; i < width; ++i) {
            if (!ellipse_inside(i, j, width, height)) {
                continue;
            }
            const bool boundary = !ellipse_inside(i - 1, j, width, height) ||
                                  !ellipse_inside(i + 1, j, width, height) ||
                                  !ellipse_inside(i, j - 1, width, height) ||
                                  !ellipse_inside(i, j + 1, width, height);
            if (filled || boundary) {
                plot(frame, clip, x + i, y + j, color);
            }
        }
    }
}

/* A size x size circle, in 128-bit arithmetic for the largest boxes. */
static bool big_inside(int64_t i, int64_t j, int64_t size) {
    if (i < 0 || j < 0 || i >= size || j >= size) {
        return false;
    }
    const wide_int dx = 2 * i + 1 - size;
    const wide_int dy = 2 * j + 1 - size;
    return dx * dx + dy * dy <= (wide_int)size * size;
}

static void test_ellipses(void) {
    px_context *context = create_context(WIDTH, HEIGHT);
    uint8_t bytes[PX_HEADER_BYTES + 4 * PX_RECORD_BYTES];
    uint8_t expected[WIDTH * HEIGHT];
    uint32_t seed = UINT32_C(0x9e3779b9);
    size_t compared = 0;
    for (size_t iteration = 0; iteration < 20000; ++iteration) {
        const bool filled = (iteration & 1U) != 0;
        const int32_t x = random_range(&seed, -20, 24);
        const int32_t y = random_range(&seed, -16, 18);
        const int32_t width = random_range(&seed, 0, 40);
        const int32_t height = random_range(&seed, 0, 40);
        const int32_t camera_x = random_range(&seed, -6, 6);
        const int32_t camera_y = random_range(&seed, -6, 6);
        int32_t clip_box_args[4];
        random_clip(&seed, clip_box_args);
        const int32_t clip_x = clip_box_args[0];
        const int32_t clip_y = clip_box_args[1];
        const int32_t clip_w = clip_box_args[2];
        const int32_t clip_h = clip_box_args[3];
        const size_t length = batch_header(bytes, 4);
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, camera_x, camera_y, 0, 0, 0, 0);
        command(bytes, 2, PX_OP_SET_CLIP, 0, 0, clip_x, clip_y, clip_w, clip_h, 0, 0);
        command(bytes, 3, (uint16_t)(filled ? PX_OP_ELLIPSE_FILL : PX_OP_ELLIPSE), 0, 0, x, y,
                width, height, 7, 0);
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        const clip_box clip = clamp_clip(clip_x, clip_y, clip_w, clip_h);
        memset(expected, 0, sizeof(expected));
        reference_ellipse(expected, &clip, (int64_t)x - camera_x, (int64_t)y - camera_y, width,
                          height, 7, filled);
        CHECK(memcmp(expected, px_frame_data(context), sizeof(expected)) == 0);
        compared += count_drawn(expected);
    }
    CHECK(compared > 500000);

    /* The largest ellipse outline is exact where its bottom crosses the
     * screen; larger boxes and negative sizes are rejected. */
    const int64_t size = PX_MAX_ELLIPSE_DIMENSION;
    size_t length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_ELLIPSE, 0, 0, -(int32_t)(size / 2) + 3, -(int32_t)size + 12,
            (int32_t)size, (int32_t)size, 5, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *frame = px_frame_data(context);
    size_t outline = 0;
    for (int64_t py = 0; py < HEIGHT; ++py) {
        for (int64_t px = 0; px < WIDTH; ++px) {
            const int64_t i = px + size / 2 - 3;
            const int64_t j = py + size - 12;
            const bool drawn = big_inside(i, j, size) &&
                               (!big_inside(i - 1, j, size) || !big_inside(i + 1, j, size) ||
                                !big_inside(i, j - 1, size) || !big_inside(i, j + 1, size));
            CHECK(frame[py * WIDTH + px] == (drawn ? 5 : 0));
            outline += drawn ? 1U : 0U;
        }
    }
    CHECK(outline > 0);
    command(bytes, 1, PX_OP_ELLIPSE_FILL, 0, 0, 0, 0, (int32_t)size + 1, 4, 5, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_ELLIPSE_FILL, 0, 0, 0, 0, 4, -1, 5, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_ELLIPSE, 0, 0, 0, 0, 4, 4, 5, 1);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    px_context_destroy(context);
}

/* Pixel centers inside or on the triangle, in exact integer arithmetic. */
static bool triangle_covers(const int64_t xs[3], const int64_t ys[3], int64_t px, int64_t py) {
    const wide_int area = (wide_int)(xs[1] - xs[0]) * (ys[2] - ys[0]) -
                          (wide_int)(ys[1] - ys[0]) * (xs[2] - xs[0]);
    if (area == 0) {
        return false;
    }
    for (size_t edge = 0; edge < 3; ++edge) {
        const size_t next = (edge + 1) % 3;
        const wide_int value = (wide_int)(xs[next] - xs[edge]) * (2 * py + 1 - 2 * ys[edge]) -
                               (wide_int)(ys[next] - ys[edge]) * (2 * px + 1 - 2 * xs[edge]);
        if ((area > 0 && value < 0) || (area < 0 && value > 0)) {
            return false;
        }
    }
    return true;
}

static void reference_triangle(uint8_t *frame, const clip_box *clip, const int64_t xs[3],
                               const int64_t ys[3], uint8_t color, bool filled, bool short_edges) {
    if (filled) {
        for (int64_t py = clip->top; py < clip->bottom; ++py) {
            for (int64_t px = clip->left; px < clip->right; ++px) {
                if (triangle_covers(xs, ys, px, py)) {
                    frame[py * WIDTH + px] = color;
                }
            }
        }
    }
    if (short_edges) {
        for (size_t edge = 0; edge < 3; ++edge) {
            const size_t next = (edge + 1) % 3;
            walk_line(frame, clip, xs[edge], ys[edge], xs[next], ys[next], color);
        }
    }
}

static void test_triangles(void) {
    px_context *context = create_context(WIDTH, HEIGHT);
    uint8_t bytes[PX_HEADER_BYTES + 5 * PX_RECORD_BYTES];
    uint8_t expected[WIDTH * HEIGHT];
    uint32_t seed = UINT32_C(0x2545f491);
    size_t compared = 0;
    for (size_t iteration = 0; iteration < 20000; ++iteration) {
        const bool filled = (iteration & 1U) != 0;
        int32_t vertex[6];
        for (size_t index = 0; index < 6; ++index) {
            vertex[index] = (index & 1U) == 0 ? random_range(&seed, -20, WIDTH + 20)
                                              : random_range(&seed, -16, HEIGHT + 16);
        }
        if (iteration % 7 == 0) {
            /* Collinear or repeated vertices. */
            vertex[4] = vertex[0] + (vertex[2] - vertex[0]) * 2;
            vertex[5] = vertex[1] + (vertex[3] - vertex[1]) * 2;
        }
        const int32_t camera_x = random_range(&seed, -8, 8);
        const int32_t camera_y = random_range(&seed, -8, 8);
        int32_t clip_box_args[4];
        random_clip(&seed, clip_box_args);
        const int32_t clip_x = clip_box_args[0];
        const int32_t clip_y = clip_box_args[1];
        const int32_t clip_w = clip_box_args[2];
        const int32_t clip_h = clip_box_args[3];
        const size_t length = batch_header(bytes, 5);
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, camera_x, camera_y, 0, 0, 0, 0);
        command(bytes, 2, PX_OP_SET_CLIP, 0, 0, clip_x, clip_y, clip_w, clip_h, 0, 0);
        command(bytes, 3, (uint16_t)(filled ? PX_OP_TRIANGLE_FILL : PX_OP_TRIANGLE), 0, 0,
                vertex[0], vertex[1], vertex[2], vertex[3], vertex[4], vertex[5]);
        command(bytes, 4, PX_OP_PARAMS, 0, 0, 9, 0, 0, 0, 0, 0);
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        const clip_box clip = clamp_clip(clip_x, clip_y, clip_w, clip_h);
        const int64_t xs[3] = {(int64_t)vertex[0] - camera_x, (int64_t)vertex[2] - camera_x,
                               (int64_t)vertex[4] - camera_x};
        const int64_t ys[3] = {(int64_t)vertex[1] - camera_y, (int64_t)vertex[3] - camera_y,
                               (int64_t)vertex[5] - camera_y};
        memset(expected, 0, sizeof(expected));
        reference_triangle(expected, &clip, xs, ys, 9, filled, true);
        CHECK(memcmp(expected, px_frame_data(context), sizeof(expected)) == 0);
        compared += count_drawn(expected);
    }
    CHECK(compared > 500000);

    size_t covered = 0;
    /* Full-range vertices: the interior is exact with 128-bit edge functions.
     * Edges are too long to walk here, so the check covers pixels inside the
     * triangle only, and the outline's pixels are compared separately below. */
    for (size_t iteration = 0; iteration < 4000; ++iteration) {
        int32_t vertex[6];
        for (size_t index = 0; index < 6; ++index) {
            vertex[index] = (int32_t)random_u32(&seed);
        }
        const int32_t camera_x = (int32_t)random_u32(&seed);
        const int32_t camera_y = (int32_t)random_u32(&seed);
        size_t length = batch_header(bytes, 4);
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, camera_x, camera_y, 0, 0, 0, 0);
        command(bytes, 2, PX_OP_TRIANGLE_FILL, 0, 0, vertex[0], vertex[1], vertex[2], vertex[3],
                vertex[4], vertex[5]);
        command(bytes, 3, PX_OP_PARAMS, 0, 0, 4, 0, 0, 0, 0, 0);
        const px_result result = px_context_submit(context, bytes, length);
        if (result == PX_ERR_CAPACITY) {
            continue; /* Edges crossing the screen for millions of pixels. */
        }
        CHECK(result == PX_OK);
        const int64_t xs[3] = {(int64_t)vertex[0] - camera_x, (int64_t)vertex[2] - camera_x,
                               (int64_t)vertex[4] - camera_x};
        const int64_t ys[3] = {(int64_t)vertex[1] - camera_y, (int64_t)vertex[3] - camera_y,
                               (int64_t)vertex[5] - camera_y};
        const uint8_t *frame = px_frame_data(context);
        for (int64_t py = 0; py < HEIGHT; ++py) {
            for (int64_t px = 0; px < WIDTH; ++px) {
                if (triangle_covers(xs, ys, px, py)) {
                    CHECK(frame[py * WIDTH + px] == 4);
                    ++covered;
                }
            }
        }
    }
    CHECK(covered > 100000);

    /* A triangle covering the whole screen from far outside fills it. */
    size_t length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_TRIANGLE_FILL, 0, 0, -2000000000, -2000000000, 2000000000, -1000, -7,
            2000000000);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 3, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    for (size_t index = 0; index < WIDTH * HEIGHT; ++index) {
        CHECK(px_frame_data(context)[index] == 3);
    }

    /* PARAMS must follow the opcodes that declare it, and only them. */
    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 6, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_TRIANGLE, 0, 0, 0, 0, 5, 5, 0, 5);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    CHECK(px_last_diagnostic(context).command_index == 1);
    CHECK(px_frame_data(context)[0] != 6);
    command(bytes, 1, PX_OP_PARAMS, 0, 0, 3, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_TRIANGLE, 0, 0, 0, 0, 5, 5, 0, 5);
    command(bytes, 1, PX_OP_CLEAR, 0, 0, 3, 0, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_CLEAR, 0, 0, 3, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 1, PX_OP_PARAMS, 1, 0, 3, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 1, PX_OP_PARAMS, 0, 4097, 3, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 1, PX_OP_PARAMS, 0, 0, 3, 1, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 1, PX_OP_PARAMS, 0, 0, 16, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_PARAMS, 0, 0, 3, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    px_context_destroy(context);
}

/* 4-connected region of the seed's color inside the clip. */
static void reference_fill(uint8_t *frame, const clip_box *clip, int64_t x, int64_t y,
                           uint8_t color) {
    if (x < clip->left || x >= clip->right || y < clip->top || y >= clip->bottom) {
        return;
    }
    const uint8_t target = frame[y * WIDTH + x];
    if (target == color) {
        return;
    }
    static int64_t queue[WIDTH * HEIGHT];
    size_t head = 0;
    size_t tail = 0;
    queue[tail++] = y * WIDTH + x;
    frame[y * WIDTH + x] = color;
    while (head < tail) {
        const int64_t at = queue[head++];
        const int64_t neighbours[4][2] = {
            {at % WIDTH - 1, at / WIDTH},
            {at % WIDTH + 1, at / WIDTH},
            {at % WIDTH, at / WIDTH - 1},
            {at % WIDTH, at / WIDTH + 1},
        };
        for (size_t index = 0; index < 4; ++index) {
            const int64_t nx = neighbours[index][0];
            const int64_t ny = neighbours[index][1];
            if (nx >= clip->left && nx < clip->right && ny >= clip->top && ny < clip->bottom &&
                frame[ny * WIDTH + nx] == target) {
                frame[ny * WIDTH + nx] = color;
                queue[tail++] = ny * WIDTH + nx;
            }
        }
    }
}

static void test_flood_fill(void) {
    px_context *context = create_context(WIDTH, HEIGHT);
    static uint8_t bytes[PX_HEADER_BYTES + 1024 * PX_RECORD_BYTES];
    uint8_t expected[WIDTH * HEIGHT];
    uint32_t seed = UINT32_C(0x68e31da4);
    size_t changed = 0;
    for (size_t iteration = 0; iteration < 20000; ++iteration) {
        /* Random walls of three colors, then a fill from a random seed. */
        const uint32_t count = WIDTH * HEIGHT + 4;
        const size_t length = batch_header(bytes, count);
        const uint32_t density = (random_u32(&seed) & 3U) == 0 ? 40 + random_u32(&seed) % 31
                                                                : random_u32(&seed) % 36;
        for (uint32_t index = 0; index < WIDTH * HEIGHT; ++index) {
            const uint32_t roll = random_u32(&seed) % 100;
            const uint8_t color = roll < density ? (uint8_t)(1 + roll % 2) : 0;
            expected[index] = color;
            command(bytes, index, PX_OP_PIXEL, 0, 0, (int32_t)(index % WIDTH),
                    (int32_t)(index / WIDTH), color, 0, 0, 0);
        }
        const int32_t camera_x = random_range(&seed, -3, 3);
        const int32_t camera_y = random_range(&seed, -3, 3);
        int32_t clip_box_args[4];
        random_clip(&seed, clip_box_args);
        const int32_t clip_x = clip_box_args[0];
        const int32_t clip_y = clip_box_args[1];
        const int32_t clip_w = clip_box_args[2];
        const int32_t clip_h = clip_box_args[3];
        const int32_t x = random_range(&seed, camera_x, WIDTH - 1 + camera_x);
        const int32_t y = random_range(&seed, camera_y, HEIGHT - 1 + camera_y);
        const uint8_t color = (uint8_t)random_range(&seed, 0, 3);
        command(bytes, WIDTH * HEIGHT, PX_OP_SET_CAMERA, 0, 0, camera_x, camera_y, 0, 0, 0, 0);
        command(bytes, WIDTH * HEIGHT + 1, PX_OP_SET_CLIP, 0, 0, clip_x, clip_y, clip_w, clip_h,
                0, 0);
        command(bytes, WIDTH * HEIGHT + 2, PX_OP_FILL, 0, 0, x, y, color, 0, 0, 0);
        command(bytes, WIDTH * HEIGHT + 3, PX_OP_RESET_CLIP, 0, 0, 0, 0, 0, 0, 0, 0);
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        const clip_box clip = clamp_clip(clip_x, clip_y, clip_w, clip_h);
        uint8_t before[WIDTH * HEIGHT];
        memcpy(before, expected, sizeof(before));
        reference_fill(expected, &clip, (int64_t)x - camera_x, (int64_t)y - camera_y, color);
        CHECK(memcmp(expected, px_frame_data(context), sizeof(expected)) == 0);
        for (size_t index = 0; index < sizeof(before); ++index) {
            changed += before[index] != expected[index] ? 1U : 0U;
        }
    }
    CHECK(changed > 500000);
    px_context_destroy(context);

    /* The largest framebuffer: a full fill and a comb that keeps hundreds of
     * seeds pending stay within the work budget and the preallocated stack. */
    context = create_context(PX_MAX_DIMENSION, PX_MAX_DIMENSION);
    size_t length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_FILL, 0, 0, 511, 700, 5, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *frame = px_frame_data(context);
    CHECK(frame[0] == 5 && frame[(size_t)PX_MAX_DIMENSION * PX_MAX_DIMENSION - 1] == 5);
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_FILL, 0, 0, 3, 3, 5, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK); /* Already that color. */
    const uint32_t teeth = PX_MAX_DIMENSION / 2;
    length = batch_header(bytes, teeth + 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    for (uint32_t tooth = 0; tooth < teeth; ++tooth) {
        command(bytes, tooth + 1, PX_OP_RECT, 0, 0, (int32_t)(tooth * 2 + 1), 1, 1,
                (int32_t)PX_MAX_DIMENSION - 1, 2, 0);
    }
    command(bytes, teeth + 1, PX_OP_FILL, 0, 0, 0, 0, 6, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(frame[0] == 6 && frame[(size_t)(PX_MAX_DIMENSION - 1) * PX_MAX_DIMENSION] == 6 &&
          frame[(size_t)PX_MAX_DIMENSION * 5 + 1] == 2);
    px_context_destroy(context);
}

static void test_remap(void) {
    px_context *context = create_context(WIDTH, HEIGHT);
    uint8_t bytes[PX_HEADER_BYTES + 8 * PX_RECORD_BYTES];
    size_t length = batch_header(bytes, 6);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 1, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_SET_REMAP, 0, 0, 1, 7, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_SET_REMAP, 0, 0, 3, 9, 0, 0, 0, 0);
    command(bytes, 3, PX_OP_RECT, 0, 0, 0, 0, 4, 4, 1, 0);
    command(bytes, 4, PX_OP_RESET_REMAP, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 5, PX_OP_PIXEL, 0, 0, 5, 5, 1, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *frame = px_frame_data(context);
    CHECK(frame[0] == 7 && frame[3 * WIDTH + 3] == 7);   /* Remapped rectangle. */
    CHECK(frame[4 * WIDTH + 4] == 1);                    /* Unmapped clear. */
    CHECK(frame[5 * WIDTH + 5] == 1);                    /* After the reset. */
    /* The table is part of the batch state: the next batch starts identity. */
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 3, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && frame[0] == 3);
    command(bytes, 0, PX_OP_SET_REMAP, 0, 0, 16, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 0, PX_OP_SET_REMAP, 0, 0, 0, -1, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 0, PX_OP_RESET_REMAP, 0, 0, 1, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    /* A remap applied only in pass one never leaks into a rejected batch. */
    length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_SET_REMAP, 0, 0, 3, 4, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_CLEAR, 0, 0, 3, 0, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_CLEAR, 0, 0, 99, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE && frame[0] == 3);
    px_context_destroy(context);
}

static uint32_t upload_image(px_context *context, uint32_t width, uint32_t height,
                             const uint8_t *pixels, uint32_t transparency) {
    uint8_t bytes[PX_HEADER_BYTES + 64 * 64];
    const size_t length = PX_HEADER_BYTES + (size_t)width * height;
    memset(bytes, 0, PX_HEADER_BYTES);
    memcpy(bytes, "PXIM", 4);
    write_u32(bytes + 4, PX_IMAGE_VERSION);
    write_u32(bytes + 8, width);
    write_u32(bytes + 12, height);
    write_u32(bytes + 16, transparency);
    write_u32(bytes + 20, (uint32_t)length);
    memcpy(bytes + PX_HEADER_BYTES, pixels, (size_t)width * height);
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, length) == PX_OK);
    CHECK(px_upload_chunk(context, bytes, length) == PX_OK);
    CHECK(px_upload_commit(context) == PX_OK);
    return px_last_resource_handle(context);
}

static int32_t sine_q16(uint32_t angle) {
    const uint32_t step = angle & 1023U;
    const uint32_t quadrant = (angle >> 10) & 3U;
    const int32_t value = px_quarter_sine[(quadrant & 1U) != 0 ? 1024U - step : step];
    return quadrant >= 2 ? -value : value;
}

/* The documented mapping: each destination pixel center, relative to the
 * sprite center in doubled pixels, turns back by the angle and shrinks by
 * the scale; floor((offset + size) / 2) selects the source pixel. The
 * whole framebuffer is scanned, so a region that is too small shows up. */
static void reference_transform(uint8_t *frame, const clip_box *clip, const uint8_t *pixels,
                                int64_t image_width, int64_t x, int64_t y, int64_t source_x,
                                int64_t source_y, int64_t width, int64_t height, uint32_t angle,
                                uint32_t scale, bool flip_x, bool flip_y, uint32_t transparency) {
    const int64_t sine = sine_q16(angle);
    const int64_t cosine = sine_q16((angle + 1024U) & 4095U);
    const int64_t inverse = (int64_t)(((UINT64_C(1) << 32) + scale / 2) / scale);
    for (int64_t py = clip->top; py < clip->bottom; ++py) {
        for (int64_t px = clip->left; px < clip->right; ++px) {
            const int64_t dx = 2 * px + 1 - (2 * x + width);
            const int64_t dy = 2 * py + 1 - (2 * y + height);
            const int64_t u = ((cosine * dx + sine * dy) * inverse) / 65536 -
                              (((cosine * dx + sine * dy) * inverse) % 65536 < 0 ? 1 : 0);
            const int64_t v = ((cosine * dy - sine * dx) * inverse) / 65536 -
                              (((cosine * dy - sine * dx) * inverse) % 65536 < 0 ? 1 : 0);
            const int64_t su = u + width * 65536;
            const int64_t sv = v + height * 65536;
            const int64_t column = su >= 0 ? su / 131072 : -((-su + 131071) / 131072);
            const int64_t line = sv >= 0 ? sv / 131072 : -((-sv + 131071) / 131072);
            if (column < 0 || column >= width || line < 0 || line >= height) {
                continue;
            }
            const int64_t sx = source_x + (flip_x ? width - 1 - column : column);
            const int64_t sy = source_y + (flip_y ? height - 1 - line : line);
            const uint8_t color = pixels[sy * image_width + sx];
            if (color != transparency) {
                frame[py * WIDTH + px] = color;
            }
        }
    }
}

static void test_transformed_sprites(void) {
    px_context *context = create_context(WIDTH, HEIGHT);
    uint8_t pixels[12 * 10];
    for (size_t index = 0; index < sizeof(pixels); ++index) {
        pixels[index] = (uint8_t)(1 + index % 15);
    }
    pixels[5] = 0; /* Transparent. */
    const uint32_t image = upload_image(context, 12, 10, pixels, 0);
    uint8_t bytes[PX_HEADER_BYTES + 6 * PX_RECORD_BYTES];
    uint8_t expected[WIDTH * HEIGHT];
    uint8_t plain[WIDTH * HEIGHT];
    uint32_t seed = UINT32_C(0x1b873593);
    size_t compared = 0;
    for (size_t iteration = 0; iteration < 20000; ++iteration) {
        const int32_t source_x = random_range(&seed, 0, 4);
        const int32_t source_y = random_range(&seed, 0, 3);
        const int32_t width = random_range(&seed, 0, 12 - source_x);
        const int32_t height = random_range(&seed, 0, 10 - source_y);
        const int32_t x = random_range(&seed, -10, WIDTH - 2);
        const int32_t y = random_range(&seed, -8, HEIGHT - 2);
        const uint16_t flags = (uint16_t)random_range(&seed, 0, 3);
        const uint32_t angle = iteration % 5 == 0 ? 0 : random_u32(&seed) % PX_ANGLE_UNITS;
        const uint32_t scale = iteration % 5 == 0 ? 65536
                               : (random_u32(&seed) & 3U) == 0
                                   ? PX_MIN_SCALE + random_u32(&seed) % (65536 - PX_MIN_SCALE)
                                   : 65536 + random_u32(&seed) % (3 * 65536);
        int32_t clip_box_args[4];
        random_clip(&seed, clip_box_args);
        const int32_t clip_x = clip_box_args[0];
        const int32_t clip_y = clip_box_args[1];
        const int32_t clip_w = clip_box_args[2];
        const int32_t clip_h = clip_box_args[3];
        size_t length = batch_header(bytes, 5);
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_SET_CLIP, 0, 0, clip_x, clip_y, clip_w, clip_h, 0, 0);
        command(bytes, 2, PX_OP_SET_REMAP, 0, 0, 3, 12, 0, 0, 0, 0);
        command(bytes, 3, PX_OP_BLIT_TRANSFORM, flags, image, x, y, source_x, source_y, width,
                height);
        command(bytes, 4, PX_OP_PARAMS, 0, 0, (int32_t)angle, (int32_t)scale, 0, 0, 0, 0);
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        const clip_box clip = clamp_clip(clip_x, clip_y, clip_w, clip_h);
        memset(expected, 0, sizeof(expected));
        reference_transform(expected, &clip, pixels, 12, x, y, source_x, source_y, width, height,
                            angle, scale, (flags & PX_FLAG_FLIP_X) != 0,
                            (flags & PX_FLAG_FLIP_Y) != 0, 0);
        for (size_t index = 0; index < sizeof(expected); ++index) {
            expected[index] = expected[index] == 3 ? 12 : expected[index];
        }
        CHECK(memcmp(expected, px_frame_data(context), sizeof(expected)) == 0);
        compared += count_drawn(expected);
        if (angle == 0 && scale == 65536) {
            /* No rotation at scale 1 is exactly the ordinary sprite. */
            length = batch_header(bytes, 4);
            command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
            command(bytes, 1, PX_OP_SET_CLIP, 0, 0, clip_x, clip_y, clip_w, clip_h, 0, 0);
            command(bytes, 2, PX_OP_SET_REMAP, 0, 0, 3, 12, 0, 0, 0, 0);
            command(bytes, 3, PX_OP_BLIT, flags, image, x, y, source_x, source_y, width, height);
            CHECK(px_context_submit(context, bytes, length) == PX_OK);
            memcpy(plain, px_frame_data(context), sizeof(plain));
            CHECK(memcmp(expected, plain, sizeof(plain)) == 0);
        }
    }

    CHECK(compared > 400000);
    /* Quarter turns are exact permutations and a half turn equals both flips. */
    uint8_t square[4 * 4];
    for (size_t index = 0; index < 16; ++index) {
        square[index] = (uint8_t)(1 + index % 15);
    }
    const uint32_t tile = upload_image(context, 4, 4, square, PX_NO_TRANSPARENCY);
    size_t length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, tile, 6, 5, 0, 0, 4, 4);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 1024, 65536, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *frame = px_frame_data(context);
    for (int32_t j = 0; j < 4; ++j) {
        for (int32_t i = 0; i < 4; ++i) {
            /* A clockwise quarter turn shows source (column j, row 3 - i). */
            CHECK(frame[(5 + j) * WIDTH + 6 + i] == square[(3 - i) * 4 + j]);
        }
    }
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 2048, 65536, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    memcpy(plain, frame, sizeof(plain));
    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_BLIT, PX_FLAG_FLIP_X | PX_FLAG_FLIP_Y, tile, 6, 5, 0, 0, 4, 4);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(memcmp(plain, frame, sizeof(plain)) == 0);
    /* Scale 2 doubles every source pixel about the center. */
    length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, tile, 10, 8, 0, 0, 4, 4);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 0, 131072, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    for (int32_t j = 0; j < 8; ++j) {
        for (int32_t i = 0; i < 8; ++i) {
            CHECK(frame[(6 + j) * WIDTH + 8 + i] == square[(j / 2) * 4 + i / 2]);
        }
    }

    /* Validation: source inside the image, angle and scale ranges, PARAMS. */
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, image, 0, 0, 8, 0, 5, 6);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, image, 0, 0, 0, 5, 12, 6);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, image, 0, 0, -1, 0, 5, 6);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, image, 0, 0, 0, 0, 8, 6);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, (int32_t)PX_ANGLE_UNITS, 65536, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 0, (int32_t)PX_MIN_SCALE - 1, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 0, (int32_t)PX_MAX_SCALE + 1, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, -1, 65536, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 0, 65536, 1, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 4, image, 0, 0, 0, 0, 8, 6);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 0, 65536, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, tile + 1, 0, 0, 0, 0, 1, 1);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_HANDLE);
    /* The largest sprite at the largest scale is bounded by its screen area. */
    px_context_destroy(context);
    context = create_context(PX_MAX_DIMENSION, PX_MAX_DIMENSION);
    static uint8_t big[PX_HEADER_BYTES + PX_MAX_IMAGE_PIXELS];
    memset(big, 0, PX_HEADER_BYTES);
    memcpy(big, "PXIM", 4);
    write_u32(big + 4, PX_IMAGE_VERSION);
    write_u32(big + 8, PX_MAX_DIMENSION);
    write_u32(big + 12, PX_MAX_DIMENSION);
    write_u32(big + 16, PX_NO_TRANSPARENCY);
    write_u32(big + 20, (uint32_t)sizeof(big));
    memset(big + PX_HEADER_BYTES, 4, PX_MAX_IMAGE_PIXELS);
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, sizeof(big)) == PX_OK);
    for (size_t offset = 0; offset < sizeof(big); offset += PX_MAILBOX_BYTES) {
        const size_t chunk =
            sizeof(big) - offset < PX_MAILBOX_BYTES ? sizeof(big) - offset : PX_MAILBOX_BYTES;
        CHECK(px_upload_chunk(context, big + offset, chunk) == PX_OK);
    }
    CHECK(px_upload_commit(context) == PX_OK);
    const uint32_t handle = px_last_resource_handle(context);
    command(bytes, 1, PX_OP_BLIT_TRANSFORM, 0, handle, 0, 0, 0, 0, (int32_t)PX_MAX_DIMENSION,
            (int32_t)PX_MAX_DIMENSION);
    command(bytes, 2, PX_OP_PARAMS, 0, 0, 777, (int32_t)PX_MAX_SCALE, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(px_frame_data(context)[512 * PX_MAX_DIMENSION + 512] == 4);
    px_context_destroy(context);
}

int main(void) {
    test_ellipses();
    test_triangles();
    test_flood_fill();
    test_remap();
    test_transformed_sprites();
    puts("PixelJS shapes: 5 contract groups passed (20,000 ellipse, 24,000 triangle, 20,000 "
         "flood-fill and 20,000 transformed-sprite cases).");
    return EXIT_SUCCESS;
}
