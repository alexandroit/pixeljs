#include "internal.h"

uint16_t px_read_u16(const uint8_t *bytes) {
    return (uint16_t)((uint16_t)bytes[0] | (uint16_t)((uint16_t)bytes[1] << 8));
}

uint32_t px_read_u32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) | ((uint32_t)bytes[2] << 16) |
           ((uint32_t)bytes[3] << 24);
}

int32_t px_read_i32(const uint8_t *bytes) {
    const uint32_t value = px_read_u32(bytes);
    /* Avoid implementation-defined unsigned-to-signed conversion. */
    return value <= INT32_MAX ? (int32_t)value : (int32_t)((int64_t)value - INT64_C(4294967296));
}

bool px_dimensions_size(uint32_t width, uint32_t height, size_t *out_size) {
    *out_size = 0;
    if (width == 0 || height == 0 || width > PX_MAX_DIMENSION || height > PX_MAX_DIMENSION) {
        return false;
    }
    if ((size_t)height > SIZE_MAX / (size_t)width) {
        return false;
    }
    const size_t size = (size_t)width * (size_t)height;
    if (size > PX_MAX_IMAGE_PIXELS) {
        return false;
    }
    *out_size = size;
    return true;
}

void *px_allocate(px_context *context, size_t size) {
    if (size == 0 || context->live_bytes > context->config.memory_budget_bytes ||
        size > context->config.memory_budget_bytes - context->live_bytes) {
        return NULL;
    }
    void *memory = context->allocator.allocate(context->allocator.userdata, size);
    if (memory != NULL) {
        context->live_bytes += size;
        if (context->allocation_count != SIZE_MAX) {
            context->allocation_count += 1;
        }
    }
    return memory;
}

void px_deallocate(px_context *context, void *memory, size_t size) {
    if (memory != NULL) {
        context->allocator.deallocate(context->allocator.userdata, memory, size);
        context->live_bytes -= size;
    }
}

px_result px_finish(px_context *context, px_result result) {
    if (context != NULL) {
        context->diagnostic.result = result;
        context->diagnostic.command_index = PX_NO_COMMAND;
        context->diagnostic.byte_offset = PX_NO_COMMAND;
        context->busy = false;
    }
    return result;
}

px_result px_enter(px_context *context) {
    if (context == NULL) {
        return PX_ERR_STATE;
    }
    if (context->busy) {
        /* Do not clear the owner's busy flag on a rejected reentrant call. */
        return PX_ERR_STATE;
    }
    context->busy = true;
    return PX_OK;
}
