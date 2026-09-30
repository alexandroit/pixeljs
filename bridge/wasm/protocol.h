#ifndef PIXELJS_WASM_PROTOCOL_H
#define PIXELJS_WASM_PROTOCOL_H

#include "pixeljs/protocol.h"
#include <stdint.h>

/* Private scalar-only WASM32 ABI. Each factory instance owns one context,
 * mailbox and heap. The host holds exclusive mailbox ownership while an
 * operation runs, never reenters an export, and invalidates views on destroy.
 * Getters return zero when no context exists and never change diagnostics. */
uint32_t pxw_abi_version(void);
uint32_t pxw_initialize(uint32_t width, uint32_t height, uint32_t palette_count);
uint32_t pxw_mailbox_offset(void);
uint32_t pxw_mailbox_capacity(void);
uint32_t pxw_submit(uint32_t byte_length);
uint32_t pxw_upload_begin(uint32_t kind, uint32_t total_bytes);
uint32_t pxw_upload_chunk(uint32_t byte_length);
uint32_t pxw_upload_commit(void);
uint32_t pxw_upload_abort(void);
uint32_t pxw_last_resource_handle(void);
uint32_t pxw_resource_release(uint32_t handle);
uint32_t pxw_frame_offset(void);
uint32_t pxw_frame_stride(void);
uint32_t pxw_palette_offset(void);
uint32_t pxw_rgba_offset(void);
uint32_t pxw_expand_rgba(void);
uint32_t pxw_last_error_code(void);
uint32_t pxw_last_error_command_index(void);
uint32_t pxw_last_error_byte_offset(void);
uint32_t pxw_live_bytes(void);
uint32_t pxw_allocation_count(void);
uint32_t pxw_destroy(void);
uint32_t pxw_resize(uint32_t width, uint32_t height);
uint32_t pxw_set_palette(uint32_t palette_count);
uint32_t pxw_palette_count(void);
uint32_t pxw_palette_revision(void);

#ifndef __EMSCRIPTEN__
/* Native ABI contract tests borrow the owned mailbox without truncating native
 * 64-bit pointers. This symbol is not present in the WASM artifact. */
uint8_t *pxw_native_test_mailbox(void);
#endif

#endif
