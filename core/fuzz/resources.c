#include "support.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

/* Input: [kind selector][chunk selector][upload bytes]. The upload is split
 * into chunks with drawing in between; failures never publish, successes can
 * be released, and every path returns to the baseline allocation state. */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    if (size < 2 + PX_HEADER_BYTES || size - 2 > PX_MAX_UPLOAD_BYTES) {
        return 0;
    }
    const uint32_t kinds[3] = {PX_IMAGE_KIND, PX_TILEMAP_KIND, PX_FONT_KIND};
    const uint32_t kind = kinds[data[0] % 3];
    const size_t chunk_limit = data[1] == 0 ? PX_MAILBOX_BYTES : (size_t)data[1];
    const uint8_t *payload = data + 2;
    const size_t length = size - 2;
    px_context *context = px_fuzz_context();
    const size_t baseline = px_live_bytes(context);
    if (px_upload_begin(context, kind, length) != PX_OK) {
        abort();
    }
    uint8_t clear[PX_HEADER_BYTES + PX_RECORD_BYTES] = {0};
    memcpy(clear, "PXJS", 4);
    px_fuzz_put32(clear + 4, PX_PROTOCOL_VERSION);
    px_fuzz_put32(clear + 8, 1);
    px_fuzz_put32(clear + 12, (uint32_t)sizeof(clear));
    clear[PX_HEADER_BYTES] = (uint8_t)PX_OP_CLEAR;
    for (size_t cursor = 0; cursor < length;) {
        const size_t remaining = length - cursor;
        const size_t chunk = remaining < chunk_limit ? remaining : chunk_limit;
        if (px_upload_chunk(context, payload + cursor, chunk) != PX_OK ||
            px_context_submit(context, clear, sizeof(clear)) != PX_OK) {
            abort();
        }
        cursor += chunk;
    }
    if (px_upload_commit(context) == PX_OK) {
        const uint32_t handle = px_last_resource_handle(context);
        if (handle == 0) {
            abort();
        }
        const px_result tileset = px_resource_release(context, PX_FUZZ_IMAGE);
        if (tileset != PX_ERR_RESOURCE_IN_USE || px_resource_release(context, handle) != PX_OK) {
            abort();
        }
    } else if (px_last_resource_handle(context) != 0) {
        abort();
    }
    if (px_upload_abort(context) != PX_OK || px_live_bytes(context) != baseline) {
        abort();
    }
    px_context_destroy(context);
    return 0;
}
