#ifndef PIXELJS_PIXELJS_H
#define PIXELJS_PIXELJS_H

#include <stddef.h>
#include <stdint.h>

/* The native embedding owns valid objects/spans. A context is single-threaded
 * and non-reentrant; allocator callbacks must not call back into that context.
 * The web adapter supplies stricter scalar-only entry points. */
typedef struct px_context px_context;

typedef enum px_result {
    PX_OK = 0,
    PX_ERR_ARGUMENT,
    PX_ERR_RANGE,
    PX_ERR_CAPACITY,
    PX_ERR_OUT_OF_MEMORY,
    PX_ERR_STATE,
    PX_ERR_HANDLE,
    PX_ERR_PROTOCOL,
    PX_ERR_UNSUPPORTED,
    PX_ERR_RESOURCE_IN_USE
} px_result;

typedef struct px_config {
    uint32_t width;
    uint32_t height;
    uint32_t palette_count;
    size_t memory_budget_bytes;
} px_config;

/* allocate returns NULL or a suitably aligned allocation of exactly size bytes.
 * deallocate receives that same size. userdata remains valid through destroy.
 * NULL allocator selects malloc/free. Non-NULL requires both callbacks. */
typedef struct px_allocator {
    void *userdata;
    void *(*allocate)(void *userdata, size_t size);
    void (*deallocate)(void *userdata, void *memory, size_t size);
} px_allocator;

typedef struct px_diagnostic {
    px_result result;
    uint32_t command_index;
    uint32_t byte_offset;
} px_diagnostic;

/* config is borrowed for this call; out_context is required and is cleared
 * before validation. Caller owns the returned context until one destroy call. */
px_result px_context_create(const px_config *config, const px_allocator *allocator,
                            px_context **out_context);
/* NULL is a no-op. A destroyed native pointer must never be reused. */
void px_context_destroy(px_context *context);

/* Commands are a borrowed immutable byte span for the synchronous call and
 * must not alias context-owned allocations. Failure preserves all frame bytes.
 * No allocation, callback, or resource mutation occurs during submission. */
px_result px_context_submit(px_context *context, const uint8_t *bytes, size_t length);

/* One bounded staging upload can coexist with submissions. Chunks are copied
 * synchronously from a valid non-overlapping borrowed span. Commit publishes
 * only a completely validated immutable indexed image. The output getter is
 * zero after begin, failure, and abort. A failed upload stays abortable. */
px_result px_upload_begin(px_context *context, uint32_t kind, size_t total_bytes);
px_result px_upload_chunk(px_context *context, const uint8_t *bytes, size_t length);
px_result px_upload_commit(px_context *context);
px_result px_upload_abort(px_context *context);
uint32_t px_last_resource_handle(const px_context *context);
px_result px_resource_release(px_context *context, uint32_t handle);

/* Read-only borrows live until destroy. Frame/RGBA contents change on submit /
 * expansion respectively. The palette always holds 256 opaque RGBA8 entries;
 * only the first palette_count indices are accepted. Its revision increases
 * whenever a successful operation changes any entry. These getters do not
 * change the last diagnostic. */
const uint8_t *px_frame_data(const px_context *context);
const uint8_t *px_palette_data(const px_context *context);
const uint8_t *px_rgba_data(const px_context *context);
uint32_t px_frame_stride(const px_context *context);
size_t px_frame_size(const px_context *context);
px_result px_expand_rgba(px_context *context);
px_diagnostic px_last_diagnostic(const px_context *context);
/* Replaces the framebuffer with a cleared one. On failure the previous size and
 * pixels remain. Resources are independent of the framebuffer size. */
px_result px_context_resize(px_context *context, uint32_t width, uint32_t height);
/* palette_data holds exactly count RGBA8 entries. count must equal the size
 * chosen at creation and every alpha must be 255; failure changes nothing. */
px_result px_context_set_palette(px_context *context, const uint8_t *palette_data, uint32_t count);
uint32_t px_palette_count(const px_context *context);
uint32_t px_palette_revision(const px_context *context);
size_t px_live_bytes(const px_context *context);
size_t px_allocation_count(const px_context *context);

#endif
