#include "internal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(expression)                                                                          \
    do {                                                                                           \
        if (!(expression)) {                                                                       \
            fprintf(stderr, "Check failed at %s:%d: %s\n", __FILE__, __LINE__, #expression);       \
            exit(EXIT_FAILURE);                                                                    \
        }                                                                                          \
    } while (0)

typedef struct test_allocator {
    size_t attempts;
    size_t fail_at;
    size_t live_bytes;
    size_t live_allocations;
} test_allocator;

static void *test_allocate(void *userdata, size_t size) {
    test_allocator *state = userdata;
    state->attempts += 1;
    if (state->attempts == state->fail_at) {
        return NULL;
    }
    void *memory = malloc(size);
    CHECK(memory != NULL);
    state->live_bytes += size;
    state->live_allocations += 1;
    return memory;
}

static void test_deallocate(void *userdata, void *memory, size_t size) {
    test_allocator *state = userdata;
    CHECK(memory != NULL);
    CHECK(state->live_bytes >= size);
    CHECK(state->live_allocations > 0);
    state->live_bytes -= size;
    state->live_allocations -= 1;
    free(memory);
}

static void write_u16(uint8_t *bytes, uint16_t value) {
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
}

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
    write_u16(record, opcode);
    write_u16(record + 2, flags);
    write_u32(record + 4, handle);
    const int32_t args[6] = {a, b, c, d, e, f};
    for (size_t argument = 0; argument < 6; ++argument) {
        write_u32(record + 8 + argument * 4, (uint32_t)args[argument]);
    }
}

static px_context *create_context(uint32_t width, uint32_t height, test_allocator *state) {
    px_context *context = NULL;
    const px_config config = {width, height, 16, PX_MEMORY_BUDGET_BYTES};
    const px_allocator allocator = {state, test_allocate, test_deallocate};
    CHECK(px_context_create(&config, state != NULL ? &allocator : NULL, &context) == PX_OK);
    CHECK(context != NULL);
    return context;
}

static void image_bytes(uint8_t *bytes, uint32_t width, uint32_t height, uint32_t transparency,
                        const uint8_t *pixels) {
    const size_t pixel_count = (size_t)width * height;
    memset(bytes, 0, PX_HEADER_BYTES);
    memcpy(bytes, "PXIM", 4);
    write_u32(bytes + 4, PX_IMAGE_VERSION);
    write_u32(bytes + 8, width);
    write_u32(bytes + 12, height);
    write_u32(bytes + 16, transparency);
    write_u32(bytes + 20, (uint32_t)(PX_HEADER_BYTES + pixel_count));
    memcpy(bytes + PX_HEADER_BYTES, pixels, pixel_count);
}

static void tilemap_bytes(uint8_t *bytes, uint32_t cols, uint32_t rows, uint32_t tile_w,
                          uint32_t tile_h, uint32_t tileset_handle, const uint16_t *tiles) {
    const size_t tile_count = (size_t)cols * rows;
    const size_t total_size = PX_HEADER_BYTES + tile_count * 2;
    memset(bytes, 0, PX_HEADER_BYTES);
    memcpy(bytes, "PXTM", 4);
    write_u32(bytes + 4, PX_TILEMAP_VERSION);
    write_u32(bytes + 8, cols);
    write_u32(bytes + 12, rows);
    write_u32(bytes + 16, tile_w);
    write_u32(bytes + 20, tile_h);
    write_u32(bytes + 24, tileset_handle);
    write_u32(bytes + 28, (uint32_t)total_size);
    for (size_t index = 0; index < tile_count; ++index) {
        write_u16(bytes + PX_HEADER_BYTES + index * 2, tiles[index]);
    }
}

static uint32_t upload_image(px_context *context) {
    uint8_t bytes[38];
    const uint8_t pixels[6] = {1, 2, 0, 3, 4, 5};
    image_bytes(bytes, 3, 2, 0, pixels);
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, sizeof(bytes)) == PX_OK);
    CHECK(px_last_resource_handle(context) == 0);
    CHECK(px_upload_chunk(context, bytes, sizeof(bytes)) == PX_OK);
    CHECK(px_upload_commit(context) == PX_OK);
    const uint32_t handle = px_last_resource_handle(context);
    CHECK(handle != 0);
    return handle;
}

static void test_creation_and_allocation_failures(void) {
    px_context *output = (px_context *)(uintptr_t)1;
    px_config config = {4, 4, 16, PX_MEMORY_BUDGET_BYTES};
    CHECK(px_context_create(&config, NULL, NULL) == PX_ERR_ARGUMENT);
    CHECK(px_context_create(NULL, NULL, &output) == PX_ERR_ARGUMENT && output == NULL);
    for (size_t fail = 1; fail <= 3; ++fail) {
        test_allocator state = {0, fail, 0, 0};
        const px_allocator allocator = {&state, test_allocate, test_deallocate};
        output = (px_context *)(uintptr_t)1;
        CHECK(px_context_create(&config, &allocator, &output) == PX_ERR_OUT_OF_MEMORY);
        CHECK(output == NULL && state.live_bytes == 0 && state.live_allocations == 0);
    }
    const uint32_t invalid_sizes[] = {0, PX_MAX_DIMENSION + 1, UINT32_MAX};
    for (size_t index = 0; index < sizeof(invalid_sizes) / sizeof(invalid_sizes[0]); ++index) {
        config.width = invalid_sizes[index];
        CHECK(px_context_create(&config, NULL, &output) == PX_ERR_RANGE && output == NULL);
    }
    config.width = 4;
    config.palette_count = 0;
    CHECK(px_context_create(&config, NULL, &output) == PX_ERR_RANGE && output == NULL);
    config.palette_count = 257;
    CHECK(px_context_create(&config, NULL, &output) == PX_ERR_RANGE && output == NULL);
    config.palette_count = 16;
    config.memory_budget_bytes = 1;
    CHECK(px_context_create(&config, NULL, &output) == PX_ERR_OUT_OF_MEMORY && output == NULL);
    config.memory_budget_bytes = PX_MEMORY_BUDGET_BYTES + (size_t)1;
    CHECK(px_context_create(&config, NULL, &output) == PX_ERR_RANGE && output == NULL);
    const px_allocator invalid_allocator = {NULL, NULL, test_deallocate};
    CHECK(px_context_create(&config, &invalid_allocator, &output) == PX_ERR_ARGUMENT &&
          output == NULL);
    px_context_destroy(NULL);
    CHECK(px_frame_data(NULL) == NULL && px_frame_stride(NULL) == 0 && px_frame_size(NULL) == 0);
    CHECK(px_expand_rgba(NULL) == PX_ERR_STATE);
}

static void test_raster_and_atomicity(void) {
    test_allocator allocations = {0};
    px_context *context = create_context(4, 4, &allocations);
    uint8_t bytes[PX_HEADER_BYTES + 8 * PX_RECORD_BYTES];
    size_t length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 1, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_RECT, 0, 0, -1, -1, 3, 3, 2, 0);
    command(bytes, 2, PX_OP_PIXEL, 0, 0, 3, 3, 3, 0, 0, 0);
    const uint8_t expected[16] = {2, 2, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3};
    const size_t before = allocations.attempts;
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(memcmp(px_frame_data(context), expected, sizeof(expected)) == 0);
    CHECK(px_expand_rgba(context) == PX_OK);
    CHECK(memcmp(px_rgba_data(context), px_palette_data(context) + 2 * 4, 4) == 0);
    CHECK(allocations.attempts == before && px_allocation_count(context) == before);

    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 4, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_RECT, 0, 0, 0, 0, 4, 4, 16, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    CHECK(memcmp(px_frame_data(context), expected, sizeof(expected)) == 0);
    const px_diagnostic error = px_last_diagnostic(context);
    CHECK(error.command_index == 1 && error.byte_offset == 64 && error.result == PX_ERR_RANGE);
    (void)px_frame_stride(context);
    CHECK(px_last_diagnostic(context).command_index == 1);

    length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_RECT, 0, 0, INT32_MIN, INT32_MAX, INT32_MAX, INT32_MAX, 5, 0);
    command(bytes, 1, PX_OP_RECT, 0, 0, 0, 0, 0, INT32_MAX, 7, 0);
    command(bytes, 2, PX_OP_PIXEL, 0, 0, INT32_MIN, INT32_MAX, 8, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(memcmp(px_frame_data(context), expected, sizeof(expected)) == 0);
    CHECK(px_last_diagnostic(context).command_index == PX_NO_COMMAND);
    CHECK(px_last_diagnostic(context).byte_offset == PX_NO_COMMAND);
    px_context_destroy(context);
    CHECK(allocations.live_bytes == 0 && allocations.live_allocations == 0);
}

static void test_clip_and_camera(void) {
    px_context *context = create_context(4, 4, NULL);
    uint8_t bytes[PX_HEADER_BYTES + 6 * PX_RECORD_BYTES];
    size_t length = batch_header(bytes, 6);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, 2, 1, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_SET_CLIP, 0, 0, 1, 1, 2, 2, 0, 0);
    command(bytes, 3, PX_OP_RECT, 0, 0, 2, 1, 4, 4, 5, 0);
    command(bytes, 4, PX_OP_RESET_CLIP, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 5, PX_OP_PIXEL, 0, 0, 2, 1, 6, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t expected[16] = {6, 0, 0, 0, 0, 5, 5, 0, 0, 5, 5, 0, 0, 0, 0, 0};
    CHECK(memcmp(px_frame_data(context), expected, sizeof(expected)) == 0);
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_PIXEL, 0, 0, 0, 0, 7, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && px_frame_data(context)[0] == 7);
    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_SET_CLIP, 0, 0, INT32_MAX, INT32_MIN, INT32_MAX, INT32_MAX, 0, 0);
    command(bytes, 1, PX_OP_RECT, 0, 0, 0, 0, 4, 4, 9, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && px_frame_data(context)[0] == 7);
    px_context_destroy(context);
}

static void test_protocol_failures_and_budget(void) {
    px_context *context = create_context(4, 4, NULL);
    uint8_t bytes[PX_HEADER_BYTES + PX_RECORD_BYTES];
    const size_t length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 2, 0, 0, 0, 0, 0);
    for (size_t truncated = 0; truncated < length; ++truncated) {
        CHECK(px_context_submit(context, bytes, truncated) != PX_OK);
        CHECK(px_frame_data(context)[0] == 0);
    }
    CHECK(px_context_submit(context, NULL, length) == PX_ERR_ARGUMENT);
    CHECK(px_context_submit(context, bytes, PX_MAILBOX_BYTES + (size_t)1) == PX_ERR_CAPACITY);
    bytes[0] = 'Q';
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    bytes[0] = 'P';
    write_u32(bytes + 4, PX_PROTOCOL_VERSION + 1);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    write_u32(bytes + 4, PX_PROTOCOL_VERSION);
    write_u32(bytes + 8, PX_MAX_COMMANDS + 1);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_CAPACITY);
    write_u32(bytes + 8, 1);
    write_u32(bytes + 12, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    write_u32(bytes + 12, (uint32_t)length);
    for (size_t offset = 20; offset < PX_HEADER_BYTES; offset += 4) {
        write_u32(bytes + offset, 1);
        CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
        CHECK(px_last_diagnostic(context).byte_offset == offset);
        write_u32(bytes + offset, 0);
    }
    command(bytes, 0, UINT16_MAX, 0, 0, 0, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_UNSUPPORTED);
    command(bytes, 0, PX_OP_CLEAR, 1, 0, 0, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 0, PX_OP_CLEAR, 0, 1, 0, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 1);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 0, PX_OP_RECT, 0, 0, 0, 0, -1, 1, 2, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    CHECK(px_frame_data(context)[0] == 0);
    px_context_destroy(context);

    context = create_context(PX_MAX_DIMENSION, PX_MAX_DIMENSION, NULL);
    uint8_t large_batch[PX_HEADER_BYTES + 16 * PX_RECORD_BYTES];
    const size_t large_length = batch_header(large_batch, 16);
    for (size_t index = 0; index < 16; ++index) {
        command(large_batch, index, PX_OP_CLEAR, 0, 0, 9, 0, 0, 0, 0, 0);
    }
    CHECK(px_context_submit(context, large_batch, large_length) == PX_ERR_CAPACITY);
    CHECK(px_last_diagnostic(context).command_index == 15);
    CHECK(px_frame_data(context)[0] == 0);
    px_context_destroy(context);
}

static void test_upload_lifecycle(void) {
    test_allocator allocations = {0};
    px_context *context = create_context(4, 4, &allocations);
    const size_t baseline = allocations.live_bytes;
    allocations.fail_at = allocations.attempts + 1;
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, 38) == PX_ERR_OUT_OF_MEMORY);
    CHECK(px_last_resource_handle(context) == 0 && allocations.live_bytes == baseline);
    allocations.fail_at = 0;
    CHECK(px_upload_begin(context, 999, 38) == PX_ERR_UNSUPPORTED);
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, 31) == PX_ERR_RANGE);
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, PX_MAX_UPLOAD_BYTES + (size_t)1) == PX_ERR_RANGE);
    CHECK(px_upload_chunk(context, (const uint8_t *)"a", 1) == PX_ERR_STATE);
    CHECK(px_upload_commit(context) == PX_ERR_STATE);

    uint8_t image[38];
    const uint8_t pixels[6] = {1, 2, 0, 3, 4, 5};
    image_bytes(image, 3, 2, 0, pixels);
    for (size_t split = 0; split < sizeof(image); ++split) {
        CHECK(px_upload_begin(context, PX_IMAGE_KIND, sizeof(image)) == PX_OK);
        if (split != 0)
            CHECK(px_upload_chunk(context, image, split) == PX_OK);
        CHECK(px_upload_commit(context) == PX_ERR_STATE);
        CHECK(px_upload_abort(context) == PX_OK);
        CHECK(allocations.live_bytes == baseline && px_last_resource_handle(context) == 0);
    }
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, sizeof(image)) == PX_OK);
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, sizeof(image)) == PX_ERR_STATE);
    CHECK(px_upload_chunk(context, NULL, 1) == PX_ERR_ARGUMENT);
    CHECK(px_upload_chunk(context, image, 0) == PX_ERR_ARGUMENT);
    CHECK(px_upload_chunk(context, image, sizeof(image) + 1) == PX_ERR_CAPACITY);
    CHECK(px_upload_chunk(context, image, 19) == PX_OK);
    uint8_t draw[64];
    const size_t length = batch_header(draw, 1);
    command(draw, 0, PX_OP_CLEAR, 0, 0, 7, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, draw, length) == PX_OK && px_frame_data(context)[0] == 7);
    CHECK(px_upload_chunk(context, image + 19, sizeof(image) - 19) == PX_OK);
    const size_t attempts_before_commit = allocations.attempts;
    CHECK(px_upload_commit(context) == PX_OK && px_last_resource_handle(context) != 0);
    CHECK(allocations.attempts == attempts_before_commit);
    const uint32_t handle = px_last_resource_handle(context);
    CHECK(px_resource_release(context, handle) == PX_OK);
    CHECK(px_resource_release(context, handle) == PX_ERR_HANDLE);
    CHECK(allocations.live_bytes == baseline);
    CHECK(px_upload_abort(context) == PX_OK);
    px_context_destroy(context);
    CHECK(allocations.live_bytes == 0 && allocations.live_allocations == 0);
}

static void test_image_errors(void) {
    px_context *context = create_context(4, 4, NULL);
    const uint8_t pixels[6] = {1, 2, 0, 3, 4, 5};
    uint8_t bytes[38];
    const size_t offsets[] = {0, 4, 8, 12, 16, 20, 24, 28, 32};
    for (size_t index = 0; index < sizeof(offsets) / sizeof(offsets[0]); ++index) {
        const uint32_t previous = upload_image(context);
        CHECK(px_resource_release(context, previous) == PX_OK);
        image_bytes(bytes, 3, 2, 0, pixels);
        bytes[offsets[index]] = 255;
        CHECK(px_upload_begin(context, PX_IMAGE_KIND, sizeof(bytes)) == PX_OK);
        CHECK(px_upload_chunk(context, bytes, sizeof(bytes)) == PX_OK);
        CHECK(px_upload_commit(context) != PX_OK);
        CHECK(px_last_resource_handle(context) == 0);
        CHECK(px_upload_abort(context) == PX_OK);
    }
    px_context_destroy(context);
}

static void test_sprites_and_generations(void) {
    test_allocator allocations = {0};
    px_context *context = create_context(4, 4, &allocations);
    uint32_t handle = upload_image(context);
    uint8_t bytes[96];
    size_t length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 7, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_BLIT, 0, handle, -1, 0, 0, 0, 3, 2);
    const size_t before = allocations.attempts;
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t expected[16] = {2, 7, 7, 7, 4, 5, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7};
    CHECK(memcmp(px_frame_data(context), expected, sizeof(expected)) == 0);
    CHECK(allocations.attempts == before);

    command(bytes, 1, PX_OP_BLIT, PX_FLAG_FLIP_X | PX_FLAG_FLIP_Y, handle, 0, 0, 0, 0, 3, 2);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t flipped[16] = {5, 4, 3, 7, 7, 2, 1, 7, 7, 7, 7, 7, 7, 7, 7, 7};
    CHECK(memcmp(px_frame_data(context), flipped, sizeof(flipped)) == 0);

    command(bytes, 1, PX_OP_BLIT, 0, handle, 0, 0, -1, -1, 4, 3);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t source_clipped[16] = {7, 7, 7, 7, 7, 1, 2, 7, 7, 3, 4, 5, 7, 7, 7, 7};
    CHECK(memcmp(px_frame_data(context), source_clipped, sizeof(source_clipped)) == 0);
    command(bytes, 1, PX_OP_BLIT, PX_FLAG_FLIP_X, handle, 0, 0, -1, -1, 4, 3);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t source_flipped[16] = {7, 7, 7, 7, 7, 2, 1, 7, 5, 4, 3, 7, 7, 7, 7, 7};
    CHECK(memcmp(px_frame_data(context), source_flipped, sizeof(source_flipped)) == 0);

    command(bytes, 1, PX_OP_BLIT, 4, handle, 0, 0, 0, 0, 3, 2);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    command(bytes, 1, PX_OP_BLIT, 0, handle, 0, 0, 0, 0, -1, 2);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    CHECK(px_resource_release(context, handle) == PX_OK);
    command(bytes, 1, PX_OP_BLIT, 0, handle, 0, 0, 0, 0, 3, 2);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_HANDLE);
    CHECK(memcmp(px_frame_data(context), source_flipped, sizeof(source_flipped)) == 0);
    const uint32_t newer_handle = upload_image(context);
    CHECK(newer_handle != handle);
    CHECK(px_resource_release(context, handle) == PX_ERR_HANDLE);
    CHECK(px_resource_release(context, newer_handle) == PX_OK);

    /* Test the retirement boundary directly, without a million allocations. */
    context->resources[0].generation = PX_GENERATION_MAX;
    handle = upload_image(context);
    CHECK((handle >> 12) == PX_GENERATION_MAX);
    CHECK(px_resource_release(context, handle) == PX_OK && context->resources[0].retired);
    const uint32_t next_slot = upload_image(context);
    CHECK((next_slot & PX_SLOT_MASK) == 2);
    CHECK(px_resource_release(context, handle) == PX_ERR_HANDLE);
    CHECK(px_resource_release(context, 0) == PX_ERR_HANDLE);
    CHECK(px_resource_release(context, UINT32_MAX) == PX_ERR_HANDLE);
    px_context_destroy(context);
    CHECK(allocations.live_bytes == 0 && allocations.live_allocations == 0);
}

static void test_capacity_and_context_isolation(void) {
    px_context *first = create_context(1, 1, NULL);
    px_context *second = create_context(2, 2, NULL);
    uint8_t bytes[64];
    const size_t length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 9, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(first, bytes, length) == PX_OK);
    CHECK(px_frame_data(first)[0] == 9 && px_frame_data(second)[0] == 0);
    for (size_t index = 0; index < PX_MAX_RESOURCES; ++index) {
        CHECK(upload_image(first) != 0);
    }
    const uint8_t pixel = 1;
    uint8_t image[33];
    image_bytes(image, 1, 1, PX_NO_TRANSPARENCY, &pixel);
    CHECK(px_upload_begin(first, PX_IMAGE_KIND, sizeof(image)) == PX_OK);
    CHECK(px_upload_chunk(first, image, sizeof(image)) == PX_OK);
    CHECK(px_upload_commit(first) == PX_ERR_CAPACITY && px_last_resource_handle(first) == 0);
    CHECK(px_upload_abort(first) == PX_OK);
    px_context_destroy(first);
    CHECK(px_context_submit(second, bytes, length) == PX_OK && px_frame_data(second)[0] == 9);
    px_context_destroy(second);
}

static uint32_t random_u32(uint32_t *state) {
    uint32_t value = *state;
    value ^= value << 13;
    value ^= value >> 17;
    value ^= value << 5;
    *state = value;
    return value;
}

static void test_blit_against_bounded_reference(void) {
    px_context *context = create_context(4, 4, NULL);
    const uint32_t handle = upload_image(context);
    const uint8_t source[6] = {1, 2, 0, 3, 4, 5};
    const int32_t coordinates[] = {INT32_MIN, -5, -1, 0, 1, 3, 5, INT32_MAX};
    const int32_t dimensions[] = {0, 1, 2, 3, 5, INT32_MAX};
    uint8_t bytes[96];
    uint32_t seed = UINT32_C(32452843);
    for (size_t iteration = 0; iteration < 10000; ++iteration) {
        const int32_t x = coordinates[random_u32(&seed) % 8];
        const int32_t y = coordinates[random_u32(&seed) % 8];
        const int32_t sx = coordinates[random_u32(&seed) % 8];
        const int32_t sy = coordinates[random_u32(&seed) % 8];
        const int32_t width = dimensions[random_u32(&seed) % 6];
        const int32_t height = dimensions[random_u32(&seed) % 6];
        const uint16_t flags = (uint16_t)(random_u32(&seed) % 4);
        const size_t length = batch_header(bytes, 2);
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 7, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_BLIT, flags, handle, x, y, sx, sy, width, height);
        uint8_t expected[16];
        memset(expected, 7, sizeof(expected));
        /* An intentionally simple destination-driven oracle exercises extreme
         * inputs without sharing the interval clipping implementation. */
        for (int64_t dy = 0; dy < 4; ++dy) {
            for (int64_t dx = 0; dx < 4; ++dx) {
                const int64_t relative_x = dx - x;
                const int64_t relative_y = dy - y;
                if (relative_x < 0 || relative_y < 0 || relative_x >= width ||
                    relative_y >= height) {
                    continue;
                }
                const int64_t source_x =
                    (int64_t)sx +
                    ((flags & PX_FLAG_FLIP_X) != 0 ? (int64_t)width - 1 - relative_x : relative_x);
                const int64_t source_y =
                    (int64_t)sy +
                    ((flags & PX_FLAG_FLIP_Y) != 0 ? (int64_t)height - 1 - relative_y : relative_y);
                if (source_x >= 0 && source_y >= 0 && source_x < 3 && source_y < 2) {
                    const uint8_t color = source[(size_t)source_y * 3 + (size_t)source_x];
                    if (color != 0) {
                        expected[(size_t)dy * 4 + (size_t)dx] = color;
                    }
                }
            }
        }
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        CHECK(memcmp(expected, px_frame_data(context), sizeof(expected)) == 0);
    }
    px_context_destroy(context);
}

static void test_deterministic_decoder_smoke(void) {
    px_context *context = create_context(8, 8, NULL);
    uint8_t bytes[160];
    uint8_t snapshot[64];
    uint8_t palette_snapshot[PX_MAX_PALETTE_COLORS * 4];
    uint32_t seed = UINT32_C(982451653);
    for (size_t iteration = 0; iteration < 20000; ++iteration) {
        size_t length = random_u32(&seed) % sizeof(bytes);
        for (size_t index = 0; index < length; ++index) {
            bytes[index] = (uint8_t)random_u32(&seed);
        }
        if ((iteration % 2) == 0) {
            length = batch_header(bytes, 4);
            for (size_t index = PX_HEADER_BYTES; index < length; ++index) {
                bytes[index] = (uint8_t)random_u32(&seed);
            }
        }
        if ((iteration % 3) == 0 && length > PX_HEADER_BYTES) {
            /* Force palette records ahead of random data to exercise atomicity. */
            write_u16(bytes + PX_HEADER_BYTES, PX_OP_SET_PALETTE);
        }
        memcpy(snapshot, px_frame_data(context), sizeof(snapshot));
        memcpy(palette_snapshot, px_palette_data(context), sizeof(palette_snapshot));
        const uint32_t revision = px_palette_revision(context);
        const px_result result = px_context_submit(context, bytes, length);
        if (result != PX_OK) {
            CHECK(memcmp(snapshot, px_frame_data(context), sizeof(snapshot)) == 0);
            CHECK(memcmp(palette_snapshot, px_palette_data(context), sizeof(palette_snapshot)) == 0);
            CHECK(px_palette_revision(context) == revision);
        }
    }
    px_context_destroy(context);
}

static void test_extended_raster_primitives(void) {
    px_context *context = create_context(8, 8, NULL);
    uint8_t bytes[PX_HEADER_BYTES + 8 * PX_RECORD_BYTES];

    /* Test LINE */
    /* Diagonal line from (0,0) to (3,3) in color 2 */
    size_t length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_LINE, 0, 0, 0, 0, 3, 3, 2, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *frame = px_frame_data(context);
    CHECK(frame[0 * 8 + 0] == 2);
    CHECK(frame[1 * 8 + 1] == 2);
    CHECK(frame[2 * 8 + 2] == 2);
    CHECK(frame[3 * 8 + 3] == 2);
    CHECK(frame[0 * 8 + 1] == 0);

    /* Line completely outside bounds: (-100, -100) to (-50, -50) */
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_LINE, 0, 0, -100, -100, -50, -50, 3, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(frame[0] == 2);

    /* Extreme coordinates: INT32_MIN to INT32_MAX */
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_LINE, 0, 0, INT32_MIN, 4, INT32_MAX, 4, 3, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(frame[4 * 8 + 0] == 3);
    CHECK(frame[4 * 8 + 7] == 3);

    /* Test RECTB */
    /* Clear and draw 4x4 outline at (1, 1) in color 4 */
    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_RECTB, 0, 0, 1, 1, 4, 4, 4, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    for (int32_t y = 1; y <= 4; ++y) {
        for (int32_t x = 1; x <= 4; ++x) {
            if (y == 1 || y == 4 || x == 1 || x == 4) {
                CHECK(frame[(size_t)y * 8 + (size_t)x] == 4);
            } else {
                CHECK(frame[(size_t)y * 8 + (size_t)x] == 0);
            }
        }
    }

    /* Test CIRCLE */
    /* Circle outline at (3, 3) radius 2 in color 5 */
    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_CIRCLE, 0, 0, 3, 3, 2, 5, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(frame[3 * 8 + 3] == 0);
    CHECK(frame[1 * 8 + 3] == 5);
    CHECK(frame[5 * 8 + 3] == 5);
    CHECK(frame[3 * 8 + 1] == 5);
    CHECK(frame[3 * 8 + 5] == 5);

    /* Test CIRCLE_FILL */
    /* Circle fill at (3, 3) radius 2 in color 6 */
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_CIRCLE_FILL, 0, 0, 3, 3, 2, 6, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(frame[3 * 8 + 3] == 6);
    CHECK(frame[1 * 8 + 3] == 6);
    CHECK(frame[5 * 8 + 3] == 6);

    /* Negative radius must fail with PX_ERR_RANGE */
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_CIRCLE, 0, 0, 3, 3, -1, 5, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);

    /* Test GLYPH */
    /* Clear and draw '!' (ASCII 33) using built-in font (handle 0) at (0, 0) fg=7, bg=-1 */
    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_GLYPH, 0, 0, 0, 0, 33, 7, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    bool has_fg = false;
    for (size_t i = 0; i < 64; ++i) {
        if (frame[i] == 7) {
            has_fg = true;
            break;
        }
    }
    CHECK(has_fg);

    /* Glyph with non-existent font handle must fail with PX_ERR_HANDLE */
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_GLYPH, 0, 9999, 0, 0, 33, 7, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_HANDLE);

    px_context_destroy(context);
}

static void test_tilemap_and_dependencies(void) {
    px_context *context = create_context(8, 8, NULL);
    const uint8_t tileset_pixels[16] = {
        1, 1, 2, 2,
        1, 1, 2, 2,
        3, 3, 4, 4,
        3, 3, 4, 4
    };
    uint8_t image[PX_HEADER_BYTES + 16];
    image_bytes(image, 4, 4, PX_NO_TRANSPARENCY, tileset_pixels);
    CHECK(px_upload_begin(context, PX_IMAGE_KIND, sizeof(image)) == PX_OK);
    CHECK(px_upload_chunk(context, image, sizeof(image)) == PX_OK);
    CHECK(px_upload_commit(context) == PX_OK);
    const uint32_t image_handle = px_last_resource_handle(context);
    CHECK(image_handle != 0);

    const uint16_t map_tiles[4] = {0, 1, 2, 3};
    const size_t tilemap_size = PX_HEADER_BYTES + 4 * sizeof(uint16_t);
    uint8_t map_bytes[PX_HEADER_BYTES + 8];
    tilemap_bytes(map_bytes, 2, 2, 2, 2, image_handle, map_tiles);

    CHECK(px_upload_begin(context, PX_TILEMAP_KIND, tilemap_size) == PX_OK);
    CHECK(px_upload_chunk(context, map_bytes, tilemap_size) == PX_OK);
    CHECK(px_upload_commit(context) == PX_OK);
    const uint32_t map_handle = px_last_resource_handle(context);
    CHECK(map_handle != 0);

    /* Attempting to release the image handle while tilemap is active MUST fail with PX_ERR_RESOURCE_IN_USE */
    CHECK(px_resource_release(context, image_handle) == PX_ERR_RESOURCE_IN_USE);

    /* Render the tilemap to frame at (0, 0) */
    uint8_t draw[PX_HEADER_BYTES + 2 * PX_RECORD_BYTES];
    size_t length = batch_header(draw, 2);
    command(draw, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(draw, 1, PX_OP_TILEMAP, 0, map_handle, 0, 0, 0, 0, 2, 2);
    CHECK(px_context_submit(context, draw, length) == PX_OK);

    const uint8_t *frame = px_frame_data(context);
    /* Tile 0 at (0,0)..(1,1) is color 1 */
    CHECK(frame[0 * 8 + 0] == 1 && frame[1 * 8 + 1] == 1);
    /* Tile 1 at (2,0)..(3,1) is color 2 */
    CHECK(frame[0 * 8 + 2] == 2 && frame[1 * 8 + 3] == 2);
    /* Tile 2 at (0,2)..(1,3) is color 3 */
    CHECK(frame[2 * 8 + 0] == 3 && frame[3 * 8 + 1] == 3);
    /* Tile 3 at (2,2)..(3,3) is color 4 */
    CHECK(frame[2 * 8 + 2] == 4 && frame[3 * 8 + 3] == 4);

    /* Release tilemap first -> must succeed */
    CHECK(px_resource_release(context, map_handle) == PX_OK);

    /* Now releasing image handle MUST succeed */
    CHECK(px_resource_release(context, image_handle) == PX_OK);

    px_context_destroy(context);
}

static void test_context_resize_and_palette(void) {
    test_allocator allocations = {0};
    px_context *context = create_context(4, 4, &allocations);

    /* Resize to 8x6 */
    CHECK(px_context_resize(context, 8, 6) == PX_OK);
    CHECK(context->config.width == 8);
    CHECK(context->config.height == 6);
    CHECK(px_frame_stride(context) == 8);

    /* Invalid resize dimensions */
    CHECK(px_context_resize(context, 0, 6) == PX_ERR_RANGE);
    CHECK(px_context_resize(context, 8, 0) == PX_ERR_RANGE);
    CHECK(px_context_resize(context, PX_MAX_DIMENSION + 1, 6) == PX_ERR_RANGE);

    /* Test clear and frame access on resized context */
    uint8_t bytes[PX_HEADER_BYTES + PX_RECORD_BYTES];
    size_t length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 5, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *frame = px_frame_data(context);
    CHECK(frame[0] == 5);
    CHECK(frame[8 * 6 - 1] == 5);

    /* Allocation failure during resize */
    allocations.fail_at = allocations.attempts + 1;
    CHECK(px_context_resize(context, 10, 10) == PX_ERR_OUT_OF_MEMORY);
    allocations.fail_at = 0;

    /* Palette tests */
    uint8_t new_palette[16 * 4];
    for (size_t i = 0; i < 16; ++i) {
        new_palette[i * 4 + 0] = (uint8_t)(i * 10);
        new_palette[i * 4 + 1] = (uint8_t)(i * 15);
        new_palette[i * 4 + 2] = (uint8_t)(i * 20);
        new_palette[i * 4 + 3] = 255;
    }
    const uint32_t initial_revision = px_palette_revision(context);
    CHECK(px_context_set_palette(context, new_palette, 16) == PX_OK);
    CHECK(px_palette_count(context) == 16);
    CHECK(px_palette_revision(context) == initial_revision + 1);
    CHECK(memcmp(px_palette_data(context), new_palette, sizeof(new_palette)) == 0);

    /* The size is fixed at creation and every entry must be opaque; failures
     * change neither colors nor the revision. */
    CHECK(px_context_set_palette(context, NULL, 16) == PX_ERR_RANGE);
    CHECK(px_context_set_palette(context, new_palette, 0) == PX_ERR_RANGE);
    CHECK(px_context_set_palette(context, new_palette, 8) == PX_ERR_RANGE);
    CHECK(px_context_set_palette(context, new_palette, 257) == PX_ERR_RANGE);
    new_palette[5 * 4 + 3] = 128;
    CHECK(px_context_set_palette(context, new_palette, 16) == PX_ERR_RANGE);
    new_palette[5 * 4 + 3] = 255;
    CHECK(px_palette_revision(context) == initial_revision + 1);
    CHECK(memcmp(px_palette_data(context), new_palette, sizeof(new_palette)) == 0);

    /* A batch palette record publishes only with the successful batch. */
    length = batch_header(bytes, 1);
    command(bytes, 0, PX_OP_SET_PALETTE, 0, 0, 1, 200, 150, 100, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *pal = px_palette_data(context);
    CHECK(pal[1 * 4 + 0] == 200);
    CHECK(pal[1 * 4 + 1] == 150);
    CHECK(pal[1 * 4 + 2] == 100);
    CHECK(pal[1 * 4 + 3] == 255);
    CHECK(px_palette_revision(context) == initial_revision + 2);

    uint8_t atomic[PX_HEADER_BYTES + 2 * PX_RECORD_BYTES];
    length = batch_header(atomic, 2);
    command(atomic, 0, PX_OP_SET_PALETTE, 0, 0, 2, 1, 2, 3, 0, 0);
    command(atomic, 1, UINT16_MAX, 0, 0, 0, 0, 0, 0, 0, 0);
    uint8_t palette_before[PX_MAX_PALETTE_COLORS * 4];
    memcpy(palette_before, px_palette_data(context), sizeof(palette_before));
    CHECK(px_context_submit(context, atomic, length) == PX_ERR_UNSUPPORTED);
    CHECK(memcmp(palette_before, px_palette_data(context), sizeof(palette_before)) == 0);
    CHECK(px_palette_revision(context) == initial_revision + 2);
    command(atomic, 1, PX_OP_SET_PALETTE, 0, 0, 16, 0, 0, 0, 0, 0);
    CHECK(px_context_submit(context, atomic, length) == PX_ERR_RANGE);
    command(atomic, 1, PX_OP_SET_PALETTE, 0, 0, 3, 0, 256, 0, 0, 0);
    CHECK(px_context_submit(context, atomic, length) == PX_ERR_RANGE);
    CHECK(memcmp(palette_before, px_palette_data(context), sizeof(palette_before)) == 0);

    px_context_destroy(context);
    CHECK(allocations.live_bytes == 0 && allocations.live_allocations == 0);
}

static px_result upload_resource(px_context *context, uint32_t kind, const uint8_t *bytes,
                                 size_t length, uint32_t *out_handle) {
    *out_handle = 0;
    px_result result = px_upload_begin(context, kind, length);
    if (result != PX_OK) {
        return result;
    }
    result = px_upload_chunk(context, bytes, length);
    if (result == PX_OK) {
        result = px_upload_commit(context);
    }
    if (result == PX_OK) {
        *out_handle = px_last_resource_handle(context);
        CHECK(*out_handle != 0);
        return PX_OK;
    }
    CHECK(px_last_resource_handle(context) == 0);
    CHECK(px_upload_abort(context) == PX_OK);
    return result;
}

static void font_header(uint8_t *bytes, uint32_t glyph_width, uint32_t glyph_height,
                        uint32_t first_char, uint32_t char_count, uint32_t fallback_char,
                        size_t payload_bytes) {
    memset(bytes, 0, PX_HEADER_BYTES);
    memcpy(bytes, "PXFN", 4);
    write_u32(bytes + 4, PX_FONT_VERSION);
    write_u32(bytes + 8, glyph_width);
    write_u32(bytes + 12, glyph_height);
    write_u32(bytes + 16, first_char);
    write_u32(bytes + 20, char_count);
    write_u32(bytes + 24, fallback_char);
    write_u32(bytes + 28, (uint32_t)(PX_HEADER_BYTES + payload_bytes));
}

static size_t count_color(const px_context *context, uint8_t color) {
    size_t count = 0;
    for (size_t index = 0; index < px_frame_size(context); ++index) {
        count += px_frame_data(context)[index] == color ? 1U : 0U;
    }
    return count;
}

static void test_font_resources(void) {
    test_allocator allocations = {0};
    px_context *context = create_context(16, 8, &allocations);
    /* Two original 8x8 glyphs: 'A' is a diagonal, 'B' a top bar. */
    uint8_t font[PX_HEADER_BYTES + 16];
    font_header(font, 8, 8, 'A', 2, 'B', 16);
    for (size_t row = 0; row < 8; ++row) {
        font[PX_HEADER_BYTES + row] = (uint8_t)(0x80U >> row);
        font[PX_HEADER_BYTES + 8 + row] = row == 0 ? 0xFF : 0x00;
    }
    uint32_t handle = 0;
    CHECK(upload_resource(context, PX_FONT_KIND, font, sizeof(font), &handle) == PX_OK);

    uint8_t bytes[PX_HEADER_BYTES + 3 * PX_RECORD_BYTES];
    size_t length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_GLYPH, 0, handle, 0, 0, 'A', 5, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    for (size_t row = 0; row < 8; ++row) {
        for (size_t column = 0; column < 16; ++column) {
            CHECK(px_frame_data(context)[row * 16 + column] == (row == column ? 5 : 0));
        }
    }
    /* Characters outside the font draw the declared fallback glyph. */
    command(bytes, 1, PX_OP_GLYPH, 0, handle, 8, 0, 'Z', 6, 2, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    for (size_t column = 8; column < 16; ++column) {
        CHECK(px_frame_data(context)[column] == 6);
        CHECK(px_frame_data(context)[16 + column] == 2);
    }
    CHECK(count_color(context, 6) == 8 && count_color(context, 2) == 56);
    /* Partially clipped glyphs only write inside the frame. */
    command(bytes, 1, PX_OP_GLYPH, 0, handle, -3, -3, 'A', 7, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(count_color(context, 7) == 5);
    for (size_t index = 0; index < 5; ++index) {
        CHECK(px_frame_data(context)[index * 16 + index] == 7);
    }
    /* Invalid glyph records reject the batch before any write. */
    command(bytes, 1, PX_OP_GLYPH, 0, handle, 0, 0, -1, 7, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_GLYPH, 0, handle, 0, 0, 65536, 7, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_GLYPH, 0, handle, 0, 0, 'A', 7, -2, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_RANGE);
    command(bytes, 1, PX_OP_GLYPH, 0, handle, 0, 0, 'A', 7, -1, 1);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_PROTOCOL);
    CHECK(count_color(context, 7) == 5);

    /* A 12-pixel-wide glyph pads each row to two bytes, most significant bit first. */
    uint8_t wide[PX_HEADER_BYTES + 4];
    font_header(wide, 12, 2, '0', 1, '0', 4);
    wide[PX_HEADER_BYTES + 0] = 0xFF;
    wide[PX_HEADER_BYTES + 1] = 0xF0;
    wide[PX_HEADER_BYTES + 2] = 0x80;
    wide[PX_HEADER_BYTES + 3] = 0x10;
    uint32_t wide_handle = 0;
    CHECK(upload_resource(context, PX_FONT_KIND, wide, sizeof(wide), &wide_handle) == PX_OK);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_GLYPH, 0, wide_handle, 0, 4, '0', 3, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    for (size_t column = 0; column < 16; ++column) {
        CHECK(px_frame_data(context)[4 * 16 + column] == (column < 12 ? 3 : 0));
        CHECK(px_frame_data(context)[5 * 16 + column] == (column == 0 || column == 11 ? 3 : 0));
    }

    /* Header contracts. */
    uint32_t rejected = 0;
    font_header(font, 8, 8, 'A', 2, 'C', 16);
    CHECK(upload_resource(context, PX_FONT_KIND, font, sizeof(font), &rejected) == PX_ERR_RANGE);
    font_header(font, 8, 8, 'A', 2, '@', 16);
    CHECK(upload_resource(context, PX_FONT_KIND, font, sizeof(font), &rejected) == PX_ERR_RANGE);
    font_header(font, 8, 8, 65535, 2, 65535, 16);
    CHECK(upload_resource(context, PX_FONT_KIND, font, sizeof(font), &rejected) == PX_ERR_RANGE);
    font_header(font, 8, 8, 'A', 0, 'A', 16);
    CHECK(upload_resource(context, PX_FONT_KIND, font, sizeof(font), &rejected) == PX_ERR_RANGE);
    font_header(font, 65, 1, 'A', 1, 'A', 16);
    CHECK(upload_resource(context, PX_FONT_KIND, font, sizeof(font), &rejected) == PX_ERR_RANGE);
    font_header(font, 8, 8, 'A', 1, 'A', 16);
    CHECK(upload_resource(context, PX_FONT_KIND, font, sizeof(font), &rejected) == PX_ERR_PROTOCOL);
    CHECK(rejected == 0);

    /* Fonts are ordinary generational resources. */
    CHECK(px_resource_release(context, handle) == PX_OK);
    command(bytes, 1, PX_OP_GLYPH, 0, handle, 0, 0, 'A', 5, -1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_HANDLE);
    CHECK(px_resource_release(context, wide_handle) == PX_OK);
    px_context_destroy(context);
    CHECK(allocations.live_bytes == 0 && allocations.live_allocations == 0);
}

static void test_tilemap_validation_and_culling(void) {
    px_context *context = create_context(8, 8, NULL);
    const uint8_t tileset_pixels[16] = {1, 2, 3, 3, 2, 1, 3, 3, 4, 4, 5, 5, 4, 4, 5, 5};
    uint8_t image[PX_HEADER_BYTES + 16];
    image_bytes(image, 4, 4, 1, tileset_pixels);
    uint32_t tileset = 0;
    CHECK(upload_resource(context, PX_IMAGE_KIND, image, sizeof(image), &tileset) == PX_OK);

    uint8_t map[PX_HEADER_BYTES + 8];
    uint32_t rejected = 0;
    /* Four 2x2 tiles exist; ID 4 would read past the tileset. */
    const uint16_t out_of_range[4] = {0, 1, 2, 4};
    tilemap_bytes(map, 2, 2, 2, 2, tileset, out_of_range);
    CHECK(upload_resource(context, PX_TILEMAP_KIND, map, sizeof(map), &rejected) == PX_ERR_RANGE);
    const uint16_t single[4] = {0, 0, 0, 0};
    tilemap_bytes(map, 2, 2, 8, 8, tileset, single);
    CHECK(upload_resource(context, PX_TILEMAP_KIND, map, sizeof(map), &rejected) == PX_ERR_RANGE);
    tilemap_bytes(map, 2, 2, 257, 2, tileset, single);
    CHECK(upload_resource(context, PX_TILEMAP_KIND, map, sizeof(map), &rejected) == PX_ERR_RANGE);
    tilemap_bytes(map, 2, 2, 2, 2, tileset + 1, single);
    CHECK(upload_resource(context, PX_TILEMAP_KIND, map, sizeof(map), &rejected) == PX_ERR_HANDLE);
    CHECK(rejected == 0);

    const uint16_t tiles[4] = {3, (uint16_t)PX_EMPTY_TILE, 0, 1};
    tilemap_bytes(map, 2, 2, 2, 2, tileset, tiles);
    uint32_t handle = 0;
    CHECK(upload_resource(context, PX_TILEMAP_KIND, map, sizeof(map), &handle) == PX_OK);

    uint8_t bytes[PX_HEADER_BYTES + 3 * PX_RECORD_BYTES];
    size_t length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 7, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_TILEMAP, 0, handle, 1, 1, 0, 0, 2, 2);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    const uint8_t *frame = px_frame_data(context);
    /* Tile 3 at (1,1); the empty cell keeps the clear color; tile 0 has one
     * transparent (index 1) pixel; tile 1 at (3,3). */
    CHECK(frame[1 * 8 + 1] == 5 && frame[1 * 8 + 2] == 5 && frame[2 * 8 + 1] == 5);
    CHECK(frame[1 * 8 + 3] == 7 && frame[2 * 8 + 4] == 7);
    CHECK(frame[3 * 8 + 1] == 7 && frame[3 * 8 + 2] == 2 && frame[4 * 8 + 1] == 2);
    CHECK(frame[4 * 8 + 2] == 7);
    CHECK(frame[3 * 8 + 3] == 3 && frame[4 * 8 + 4] == 3);

    /* Camera, negative origins and source windows beyond the map are culled. */
    length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 7, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, 1, 1, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_TILEMAP, 0, handle, 0, 0, 0, 0, INT32_MAX, INT32_MAX);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(frame[0] == 5 && frame[1 * 8 + 0] == 2 && frame[2 * 8 + 0] == 7);
    CHECK(frame[1 * 8 + 1] == 3 && frame[2 * 8 + 2] == 3 && frame[1] == 7);
    command(bytes, 2, PX_OP_TILEMAP, 0, handle, INT32_MIN, INT32_MIN, 2, 2, INT32_MAX, 1);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(count_color(context, 7) == 64);
    command(bytes, 2, PX_OP_TILEMAP, 0, handle, 0, 0, INT32_MAX, 0, 1, 1);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    command(bytes, 2, PX_OP_TILEMAP, 0, tileset, 0, 0, 0, 0, 1, 1);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_HANDLE);
    /* A zero-width or zero-height clip inside a tile selects no cells. Debug
     * builds assert that no visited cell misses the clip. */
    command(bytes, 1, PX_OP_SET_CLIP, 0, 0, 3, 0, 0, 8, 0, 0);
    command(bytes, 2, PX_OP_TILEMAP, 0, handle, 0, 0, 0, 0, 2, 2);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && count_color(context, 7) == 64);
    command(bytes, 1, PX_OP_SET_CLIP, 0, 0, 0, 3, 8, 0, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && count_color(context, 7) == 64);
    CHECK(px_resource_release(context, tileset) == PX_ERR_RESOURCE_IN_USE);
    CHECK(px_resource_release(context, handle) == PX_OK);
    CHECK(px_resource_release(context, tileset) == PX_OK);
    px_context_destroy(context);
}

/* Independent reference: the whole unclipped Bresenham walk, keeping only
 * the pixels inside the clip [left, right) x [top, bottom) of an 8 x 8 frame. */
static void reference_line(uint8_t *frame, const int64_t clip[4], int64_t x0, int64_t y0,
                           int64_t x1, int64_t y1, uint8_t color) {
    const int64_t dx = x1 > x0 ? x1 - x0 : x0 - x1;
    const int64_t dy = -(y1 > y0 ? y1 - y0 : y0 - y1);
    int64_t error = dx + dy;
    for (;;) {
        if (x0 >= clip[0] && x0 < clip[2] && y0 >= clip[1] && y0 < clip[3]) {
            frame[(size_t)y0 * 8 + (size_t)x0] = color;
        }
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

#if defined(__SIZEOF_INT128__)
__extension__ typedef unsigned __int128 wide_uint;

/* Lines too long to walk: pixel k of the walk lies k steps along the major
 * axis and floor((2 * minor * k + major) / (2 * major)) along the minor one.
 * The walk comparisons validate this form; 128-bit integers evaluate it. */
static void reference_long_line(uint8_t *frame, int64_t x0, int64_t y0, int64_t x1, int64_t y1,
                                uint8_t color) {
    const int64_t dx = x1 > x0 ? x1 - x0 : x0 - x1;
    const int64_t dy = y1 > y0 ? y1 - y0 : y0 - y1;
    const bool x_major = dx >= dy;
    const int64_t major = x_major ? dx : dy;
    const int64_t minor = x_major ? dy : dx;
    const int64_t major_step = (x_major ? x1 > x0 : y1 > y0) ? 1 : -1;
    const int64_t minor_step = (x_major ? y1 > y0 : x1 > x0) ? 1 : -1;
    for (int64_t coordinate = 0; coordinate < 8; ++coordinate) {
        const int64_t k = (coordinate - (x_major ? x0 : y0)) * major_step;
        if (k < 0 || k > major) {
            continue;
        }
        const int64_t offset =
            major == 0 ? 0
                       : (int64_t)(((wide_uint)(2 * minor) * (wide_uint)k + (wide_uint)major) /
                                   (wide_uint)(2 * major));
        const int64_t other = (x_major ? y0 : x0) + minor_step * offset;
        if (other >= 0 && other < 8) {
            frame[(size_t)(x_major ? other * 8 + coordinate : coordinate * 8 + other)] = color;
        }
    }
}
#endif

static void test_bounded_work_and_extreme_geometry(void) {
    px_context *context = create_context(8, 8, NULL);
    const uint8_t *frame = px_frame_data(context);
    static uint8_t batch[PX_HEADER_BYTES + PX_MAX_COMMANDS * PX_RECORD_BYTES];

    /* The side loop of an outline rectangle visits only clipped rows: a full
     * batch of 2^31-pixel-tall outlines is cheap and exact. */
    size_t length = batch_header(batch, PX_MAX_COMMANDS);
    command(batch, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    for (size_t index = 1; index < PX_MAX_COMMANDS; ++index) {
        command(batch, index, PX_OP_RECTB, 0, 0, 1, -1000000000, 4, 2000000000, 6, 0);
    }
    CHECK(px_context_submit(context, batch, length) == PX_OK);
    for (size_t row = 0; row < 8; ++row) {
        for (size_t column = 0; column < 8; ++column) {
            CHECK(frame[row * 8 + column] == (column == 1 || column == 4 ? 6 : 0));
        }
    }
    /* Outlines beside the clip are estimated at zero work and draw nothing;
     * debug builds assert that their sides do not walk the clip rows. */
    for (size_t index = 1; index < PX_MAX_COMMANDS; ++index) {
        command(batch, index, PX_OP_RECTB, 0, 0, -100, -1000000000, 50, 2000000000, 6, 0);
    }
    CHECK(px_context_submit(context, batch, length) == PX_OK && count_color(context, 6) == 0);
    /* A one-pixel-wide outline is a vertical line, not just its top pixel. */
    uint8_t bytes[PX_HEADER_BYTES + 3 * PX_RECORD_BYTES];
    length = batch_header(bytes, 2);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_RECTB, 0, 0, 2, 1, 1, 4, 3, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(count_color(context, 3) == 4);
    for (size_t row = 1; row <= 4; ++row) {
        CHECK(frame[row * 8 + 2] == 3);
    }

    /* Circle loops scale with the radius, so the radius is part of the work. */
    command(bytes, 1, PX_OP_CIRCLE, 0, 0, 0, 0, INT32_MAX, 5, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_CAPACITY);
    CHECK(px_last_diagnostic(context).command_index == 1);
    command(bytes, 1, PX_OP_CIRCLE_FILL, 0, 0, 0, 0, INT32_MAX, 5, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_ERR_CAPACITY);
    CHECK(count_color(context, 3) == 4);
    /* Entirely invisible circles cost nothing and draw nothing. */
    command(bytes, 1, PX_OP_CIRCLE, 0, 0, INT32_MIN, INT32_MIN, INT32_MAX / 2, 5, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && count_color(context, 5) == 0);
    /* A large visible radius inside the budget still rasterizes correctly. */
    command(bytes, 1, PX_OP_CIRCLE_FILL, 0, 0, 3, 3, 1000000, 5, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && count_color(context, 5) == 64);
    command(bytes, 1, PX_OP_CIRCLE, 0, 0, 3, 1000003, 1000000, 4, 0, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    CHECK(count_color(context, 4) >= 8 && count_color(context, 4) <= 16);

    /* Full-range lines clip exactly. The camera case overflowed int64 before
     * exact clipping (reported by UBSan). */
    length = batch_header(bytes, 3);
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, 0, INT32_MAX, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_LINE, 0, 0, INT32_MAX, INT32_MIN, INT32_MIN, INT32_MAX, 2, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, INT32_MIN, INT32_MIN, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_LINE, 0, 0, INT32_MAX, INT32_MAX, INT32_MIN, INT32_MIN, 2, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_LINE, 0, 0, -1000000000, -1000000000, 1000000000, 1000000000, 3, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK);
    for (size_t index = 0; index < 8; ++index) {
        CHECK(frame[index * 8 + index] == 3);
    }
    command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
    command(bytes, 2, PX_OP_LINE, 0, 0, INT32_MIN, 5, INT32_MAX, 5, 4, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && count_color(context, 4) == 8);
    command(bytes, 2, PX_OP_LINE, 0, 0, 6, INT32_MAX, 6, INT32_MIN, 1, 0);
    CHECK(px_context_submit(context, bytes, length) == PX_OK && count_color(context, 1) == 8);

    /* Randomized lines: the clip keeps exactly the pixels of the unclipped
     * walk, wherever the endpoints are. */
    uint32_t seed = UINT32_C(2654435761);
    uint8_t expected[64];
    for (size_t iteration = 0; iteration < 20000; ++iteration) {
        const int32_t x0 = (int32_t)(random_u32(&seed) % 97) - 48;
        const int32_t y0 = (int32_t)(random_u32(&seed) % 97) - 48;
        const int32_t x1 = (int32_t)(random_u32(&seed) % 97) - 48;
        const int32_t y1 = (int32_t)(random_u32(&seed) % 97) - 48;
        const int32_t clip_x = (int32_t)(random_u32(&seed) % 8);
        const int32_t clip_y = (int32_t)(random_u32(&seed) % 8);
        const int32_t clip_w = (int32_t)(random_u32(&seed) % 9);
        const int32_t clip_h = (int32_t)(random_u32(&seed) % 9);
        length = batch_header(bytes, 3);
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_SET_CLIP, 0, 0, clip_x, clip_y, clip_w, clip_h, 0, 0);
        command(bytes, 2, PX_OP_LINE, 0, 0, x0, y0, x1, y1, 9, 0);
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        const int64_t clip[4] = {clip_x, clip_y, clip_x + clip_w > 8 ? 8 : clip_x + clip_w,
                                 clip_y + clip_h > 8 ? 8 : clip_y + clip_h};
        memset(expected, 0, sizeof(expected));
        reference_line(expected, clip, x0, y0, x1, y1, 9);
        CHECK(memcmp(expected, frame, sizeof(expected)) == 0);
    }
    /* Scrolling moves a line without changing it, even where it leaves the
     * screen: every camera offset shows a window onto one fixed walk. */
    const int64_t whole[4] = {0, 0, 8, 8};
    length = batch_header(bytes, 3);
    for (int32_t camera = -700; camera <= 700; ++camera) {
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, camera, camera / 3, 0, 0, 0, 0);
        command(bytes, 2, PX_OP_LINE, 0, 0, -600, -211, 613, 190, 5, 0);
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        memset(expected, 0, sizeof(expected));
        reference_line(expected, whole, -600 - camera, -211 - camera / 3, 613 - camera,
                       190 - camera / 3, 5);
        CHECK(memcmp(expected, frame, sizeof(expected)) == 0);
    }
#if defined(__SIZEOF_INT128__)
    /* Full-range lines whose window starts billions of steps in exercise the
     * 128-bit start computation. One endpoint is on screen, so each draws. */
    size_t drawn = 0;
    for (size_t iteration = 0; iteration < 20000; ++iteration) {
        const int32_t camera_x = (int32_t)(random_u32(&seed) >> 1) - (1 << 30);
        const int32_t camera_y = (int32_t)(random_u32(&seed) >> 1) - (1 << 30);
        const int32_t near_x = camera_x + (int32_t)(random_u32(&seed) % 8);
        const int32_t near_y = camera_y + (int32_t)(random_u32(&seed) % 8);
        const int32_t far_x = (int32_t)random_u32(&seed);
        const int32_t far_y = (int32_t)random_u32(&seed);
        const bool near_first = (random_u32(&seed) & 1U) != 0;
        const int32_t x0 = near_first ? near_x : far_x;
        const int32_t y0 = near_first ? near_y : far_y;
        const int32_t x1 = near_first ? far_x : near_x;
        const int32_t y1 = near_first ? far_y : near_y;
        command(bytes, 0, PX_OP_CLEAR, 0, 0, 0, 0, 0, 0, 0, 0);
        command(bytes, 1, PX_OP_SET_CAMERA, 0, 0, camera_x, camera_y, 0, 0, 0, 0);
        command(bytes, 2, PX_OP_LINE, 0, 0, x0, y0, x1, y1, 9, 0);
        CHECK(px_context_submit(context, bytes, length) == PX_OK);
        memset(expected, 0, sizeof(expected));
        reference_long_line(expected, (int64_t)x0 - camera_x, (int64_t)y0 - camera_y,
                            (int64_t)x1 - camera_x, (int64_t)y1 - camera_y, 9);
        CHECK(memcmp(expected, frame, sizeof(expected)) == 0);
        drawn += count_color(context, 9) > 0 ? 1U : 0U;
    }
    CHECK(drawn == 20000);
#endif
    px_context_destroy(context);

    /* Line work is proportional to its visible length, not its bounding box:
     * a full batch of full-screen diagonals fits the budget. */
    context = create_context(PX_MAX_DIMENSION, PX_MAX_DIMENSION, NULL);
    length = batch_header(batch, PX_MAX_COMMANDS);
    for (size_t index = 0; index < PX_MAX_COMMANDS; ++index) {
        command(batch, index, PX_OP_LINE, 0, 0, 0, 0, (int32_t)PX_MAX_DIMENSION - 1,
                (int32_t)PX_MAX_DIMENSION - 1, 1, 0);
    }
    CHECK(px_context_submit(context, batch, length) == PX_OK);
    CHECK(px_frame_data(context)[(PX_MAX_DIMENSION - 1) * (PX_MAX_DIMENSION + 1)] == 1);
    px_context_destroy(context);
}

int main(void) {
    test_creation_and_allocation_failures();
    test_raster_and_atomicity();
    test_clip_and_camera();
    test_protocol_failures_and_budget();
    test_upload_lifecycle();
    test_image_errors();
    test_sprites_and_generations();
    test_capacity_and_context_isolation();
    test_blit_against_bounded_reference();
    test_deterministic_decoder_smoke();
    test_extended_raster_primitives();
    test_tilemap_and_dependencies();
    test_context_resize_and_palette();
    test_font_resources();
    test_tilemap_validation_and_culling();
    test_bounded_work_and_extreme_geometry();
    puts("PixelJS core: 16 contract groups passed (20,000 decoder inputs, 10,000 blit oracle "
         "cases, 41,401 line clipping cases).");
    return EXIT_SUCCESS;
}
