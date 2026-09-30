#include "protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(expression)                                                                          \
    do {                                                                                           \
        if (!(expression)) {                                                                       \
            fprintf(stderr, "Bridge check failed at line %d: %s\n", __LINE__, #expression);        \
            exit(EXIT_FAILURE);                                                                    \
        }                                                                                          \
    } while (0)

int main(void) {
    CHECK(pxw_abi_version() == PX_ABI_VERSION);
    CHECK(pxw_mailbox_capacity() == 0 && pxw_frame_stride() == 0);
    CHECK(pxw_submit(32) == PX_WIRE_STATE);
    CHECK(pxw_last_error_command_index() == PX_NO_COMMAND);
    CHECK(pxw_initialize(0, 4, 16) == PX_WIRE_RANGE);
    CHECK(pxw_initialize(4, 4, 16) == PX_WIRE_OK);
    CHECK(pxw_initialize(4, 4, 16) == PX_WIRE_STATE);
    CHECK(pxw_last_error_code() == PX_WIRE_STATE);
    CHECK(pxw_frame_stride() == 4 && pxw_mailbox_capacity() == PX_MAILBOX_BYTES);
    /* Context, frame, RGBA view and flood-fill stack. */
    CHECK(pxw_live_bytes() > 0 && pxw_allocation_count() == 4);
    uint8_t *mailbox = pxw_native_test_mailbox();
    CHECK(mailbox != NULL);
    memset(mailbox, 0, 32);
    memcpy(mailbox, "PXJS", 4);
    mailbox[4] = (uint8_t)PX_PROTOCOL_VERSION;
    mailbox[12] = 32;
    CHECK(pxw_submit(32) == PX_WIRE_OK);
    CHECK(pxw_last_error_code() == PX_WIRE_OK);
    CHECK(pxw_last_error_command_index() == PX_NO_COMMAND);
    CHECK(pxw_last_error_byte_offset() == PX_NO_COMMAND);
    mailbox[20] = 1;
    CHECK(pxw_submit(32) == PX_WIRE_PROTOCOL);
    CHECK(pxw_last_error_byte_offset() == 20);
    (void)pxw_mailbox_offset();
    (void)pxw_frame_offset();
    (void)pxw_palette_offset();
    (void)pxw_rgba_offset();
    CHECK(pxw_last_error_byte_offset() == 20);
    CHECK(pxw_expand_rgba() == PX_WIRE_OK);
    CHECK(pxw_upload_begin(PX_IMAGE_KIND, 33) == PX_WIRE_OK);
    CHECK(pxw_upload_chunk(PX_MAILBOX_BYTES + 1) == PX_WIRE_CAPACITY);
    CHECK(pxw_last_resource_handle() == 0);
    CHECK(pxw_upload_abort() == PX_WIRE_OK);
    CHECK(pxw_resize(8, 6) == PX_WIRE_OK);
    CHECK(pxw_frame_stride() == 8);
    CHECK(pxw_resize(0, 6) == PX_WIRE_RANGE);
    CHECK(pxw_palette_count() == 16 && pxw_palette_revision() == 1);
    for (size_t index = 0; index < 16; ++index) {
        mailbox[index * 4 + 0] = (uint8_t)index;
        mailbox[index * 4 + 1] = (uint8_t)(index * 2);
        mailbox[index * 4 + 2] = (uint8_t)(index * 3);
        mailbox[index * 4 + 3] = 255;
    }
    CHECK(pxw_set_palette(16) == PX_WIRE_OK && pxw_palette_revision() == 2);
    CHECK(pxw_set_palette(8) == PX_WIRE_RANGE);
    CHECK(pxw_set_palette(0) == PX_WIRE_RANGE);
    CHECK(pxw_set_palette(257) == PX_WIRE_RANGE);
    mailbox[3] = 0;
    CHECK(pxw_set_palette(16) == PX_WIRE_RANGE && pxw_palette_revision() == 2);
    CHECK(pxw_destroy() == PX_WIRE_OK);
    CHECK(pxw_destroy() == PX_WIRE_OK);
    CHECK(pxw_live_bytes() == 0 && pxw_allocation_count() == 0);
    CHECK(pxw_frame_offset() == 0 && pxw_palette_offset() == 0 && pxw_rgba_offset() == 0);
    CHECK(pxw_mailbox_capacity() == 0 && pxw_native_test_mailbox() == NULL);
    CHECK(pxw_palette_count() == 0 && pxw_palette_revision() == 0);
    CHECK(pxw_initialize(4, 4, 16) == PX_WIRE_STATE);
    CHECK(pxw_submit(32) == PX_WIRE_STATE && pxw_upload_abort() == PX_WIRE_STATE);
    CHECK(pxw_resize(8, 6) == PX_WIRE_STATE);
    CHECK(pxw_set_palette(16) == PX_WIRE_STATE);
    CHECK(pxw_resource_release(4097) == PX_WIRE_STATE);
    CHECK(pxw_last_error_command_index() == PX_NO_COMMAND);
    CHECK(pxw_last_error_byte_offset() == PX_NO_COMMAND);
    puts("PixelJS bridge: initialization, diagnostics, upload and terminal teardown passed.");
    return EXIT_SUCCESS;
}
