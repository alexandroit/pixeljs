#include "support.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

/* Invariants: submission never allocates; a rejected batch leaves the frame,
 * the whole palette and its revision untouched. */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    if (size > PX_MAILBOX_BYTES) {
        return 0;
    }
    px_context *context = px_fuzz_context();
    uint8_t frame[256];
    uint8_t palette[PX_MAX_PALETTE_COLORS * 4];
    memcpy(frame, px_frame_data(context), sizeof(frame));
    memcpy(palette, px_palette_data(context), sizeof(palette));
    const uint32_t revision = px_palette_revision(context);
    const size_t bytes = px_live_bytes(context);
    const size_t allocations = px_allocation_count(context);
    const px_result result = px_context_submit(context, data, size);
    if (px_live_bytes(context) != bytes || px_allocation_count(context) != allocations) {
        abort();
    }
    if (result != PX_OK && (memcmp(frame, px_frame_data(context), sizeof(frame)) != 0 ||
                            memcmp(palette, px_palette_data(context), sizeof(palette)) != 0 ||
                            px_palette_revision(context) != revision)) {
        abort();
    }
    px_context_destroy(context);
    return 0;
}
