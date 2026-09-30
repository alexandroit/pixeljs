#include "pixeljs/pixeljs.h"
#include "protocol.h"
#include <stdbool.h>
#include <stddef.h>

/* These are adapter state inside one independent WASM instance, never core
 * singletons shared between engines. The fixed mailbox needs no frame malloc. */
static px_context *pxw_context = NULL;
static uint8_t pxw_mailbox[PX_MAILBOX_BYTES];
static bool pxw_terminal = false;
static uint32_t pxw_error = PX_WIRE_OK;
static uint32_t pxw_error_command = PX_NO_COMMAND;
static uint32_t pxw_error_offset = PX_NO_COMMAND;

static uint32_t pxw_wire_result(px_result result) {
    switch (result) {
    case PX_OK:
        return PX_WIRE_OK;
    case PX_ERR_ARGUMENT:
        return PX_WIRE_ARGUMENT;
    case PX_ERR_RANGE:
        return PX_WIRE_RANGE;
    case PX_ERR_CAPACITY:
        return PX_WIRE_CAPACITY;
    case PX_ERR_OUT_OF_MEMORY:
        return PX_WIRE_OUT_OF_MEMORY;
    case PX_ERR_STATE:
        return PX_WIRE_STATE;
    case PX_ERR_HANDLE:
        return PX_WIRE_HANDLE;
    case PX_ERR_PROTOCOL:
        return PX_WIRE_PROTOCOL;
    case PX_ERR_UNSUPPORTED:
        return PX_WIRE_UNSUPPORTED;
    case PX_ERR_RESOURCE_IN_USE:
        return PX_WIRE_RESOURCE_IN_USE;
    }
    return PX_WIRE_STATE;
}

static uint32_t pxw_record(px_result result, bool read_context) {
    pxw_error = pxw_wire_result(result);
    pxw_error_command = PX_NO_COMMAND;
    pxw_error_offset = PX_NO_COMMAND;
    if (read_context && pxw_context != NULL) {
        const px_diagnostic diagnostic = px_last_diagnostic(pxw_context);
        pxw_error_command = diagnostic.command_index;
        pxw_error_offset = diagnostic.byte_offset;
    }
    return pxw_error;
}

uint32_t pxw_abi_version(void) {
    return PX_ABI_VERSION;
}

uint32_t pxw_initialize(uint32_t width, uint32_t height, uint32_t palette_count) {
    if (pxw_context != NULL || pxw_terminal) {
        return pxw_record(PX_ERR_STATE, false);
    }
    const px_config config = {width, height, palette_count, PX_MEMORY_BUDGET_BYTES};
    return pxw_record(px_context_create(&config, NULL, &pxw_context), false);
}

uint32_t pxw_mailbox_offset(void) {
    return pxw_context != NULL ? (uint32_t)(uintptr_t)pxw_mailbox : 0;
}

uint32_t pxw_mailbox_capacity(void) {
    return pxw_context != NULL ? PX_MAILBOX_BYTES : 0;
}

uint32_t pxw_submit(uint32_t byte_length) {
    return pxw_record(px_context_submit(pxw_context, pxw_mailbox, byte_length), true);
}

uint32_t pxw_upload_begin(uint32_t kind, uint32_t total_bytes) {
    return pxw_record(px_upload_begin(pxw_context, kind, total_bytes), true);
}

uint32_t pxw_upload_chunk(uint32_t byte_length) {
    return pxw_record(px_upload_chunk(pxw_context, pxw_mailbox, byte_length), true);
}

uint32_t pxw_upload_commit(void) {
    return pxw_record(px_upload_commit(pxw_context), true);
}

uint32_t pxw_upload_abort(void) {
    return pxw_record(px_upload_abort(pxw_context), true);
}

uint32_t pxw_last_resource_handle(void) {
    return px_last_resource_handle(pxw_context);
}

uint32_t pxw_resource_release(uint32_t handle) {
    return pxw_record(px_resource_release(pxw_context, handle), true);
}

uint32_t pxw_frame_offset(void) {
    return (uint32_t)(uintptr_t)px_frame_data(pxw_context);
}

uint32_t pxw_frame_stride(void) {
    return px_frame_stride(pxw_context);
}

uint32_t pxw_palette_offset(void) {
    return (uint32_t)(uintptr_t)px_palette_data(pxw_context);
}

uint32_t pxw_rgba_offset(void) {
    return (uint32_t)(uintptr_t)px_rgba_data(pxw_context);
}

uint32_t pxw_expand_rgba(void) {
    return pxw_record(px_expand_rgba(pxw_context), true);
}

uint32_t pxw_last_error_code(void) {
    return pxw_error;
}

uint32_t pxw_last_error_command_index(void) {
    return pxw_error_command;
}

uint32_t pxw_last_error_byte_offset(void) {
    return pxw_error_offset;
}

uint32_t pxw_live_bytes(void) {
    return (uint32_t)px_live_bytes(pxw_context);
}

uint32_t pxw_allocation_count(void) {
    const size_t count = px_allocation_count(pxw_context);
    return count > UINT32_MAX ? UINT32_MAX : (uint32_t)count;
}

uint32_t pxw_destroy(void) {
    px_context_destroy(pxw_context);
    pxw_context = NULL;
    pxw_terminal = true;
    return pxw_record(PX_OK, false);
}

uint32_t pxw_resize(uint32_t width, uint32_t height) {
    if (pxw_terminal || pxw_context == NULL) {
        return pxw_record(PX_ERR_STATE, false);
    }
    return pxw_record(px_context_resize(pxw_context, width, height), false);
}

uint32_t pxw_set_palette(uint32_t palette_count) {
    if (pxw_terminal || pxw_context == NULL) {
        return pxw_record(PX_ERR_STATE, false);
    }
    /* The mailbox holds at most 256 entries of 4 bytes; the core checks that
     * the count matches the context and that every entry is opaque. */
    if (palette_count == 0 || palette_count > PX_MAX_PALETTE_COLORS) {
        return pxw_record(PX_ERR_RANGE, false);
    }
    return pxw_record(px_context_set_palette(pxw_context, pxw_mailbox, palette_count), false);
}

uint32_t pxw_palette_count(void) {
    return px_palette_count(pxw_context);
}

uint32_t pxw_palette_revision(void) {
    return px_palette_revision(pxw_context);
}

#ifndef __EMSCRIPTEN__
uint8_t *pxw_native_test_mailbox(void) {
    return pxw_context != NULL ? pxw_mailbox : NULL;
}
#endif
