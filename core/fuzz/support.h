#ifndef PIXELJS_FUZZ_SUPPORT_H
#define PIXELJS_FUZZ_SUPPORT_H

#include "pixeljs/pixeljs.h"
#include "pixeljs/protocol.h"
#include <stdlib.h>
#include <string.h>

/* Every fuzz input gets a fresh 16x16 context holding one resource of each
 * kind, so crashes reproduce from the input alone. Handles are deterministic:
 * image 4097, tilemap 4098 (using the image), font 4099. */
#define PX_FUZZ_IMAGE UINT32_C(4097)
#define PX_FUZZ_TILEMAP UINT32_C(4098)
#define PX_FUZZ_FONT UINT32_C(4099)

static void px_fuzz_put32(uint8_t *bytes, uint32_t value) {
    for (size_t index = 0; index < 4; ++index) {
        bytes[index] = (uint8_t)(value >> (index * 8));
    }
}

static uint32_t px_fuzz_upload(px_context *context, uint32_t kind, const uint8_t *bytes,
                               size_t length) {
    if (px_upload_begin(context, kind, length) != PX_OK ||
        px_upload_chunk(context, bytes, length) != PX_OK ||
        px_upload_commit(context) != PX_OK) {
        abort();
    }
    return px_last_resource_handle(context);
}

static px_context *px_fuzz_context(void) {
    const px_config config = {16, 16, 16, PX_MEMORY_BUDGET_BYTES};
    px_context *context = NULL;
    if (px_context_create(&config, NULL, &context) != PX_OK) {
        abort();
    }
    uint8_t image[PX_HEADER_BYTES + 16];
    memset(image, 0, sizeof(image));
    memcpy(image, "PXIM", 4);
    px_fuzz_put32(image + 4, PX_IMAGE_VERSION);
    px_fuzz_put32(image + 8, 4);
    px_fuzz_put32(image + 12, 4);
    px_fuzz_put32(image + 16, 0);
    px_fuzz_put32(image + 20, (uint32_t)sizeof(image));
    for (size_t index = 0; index < 16; ++index) {
        image[PX_HEADER_BYTES + index] = (uint8_t)index;
    }
    uint8_t tilemap[PX_HEADER_BYTES + 8] = {0};
    memcpy(tilemap, "PXTM", 4);
    px_fuzz_put32(tilemap + 4, PX_TILEMAP_VERSION);
    px_fuzz_put32(tilemap + 8, 2);
    px_fuzz_put32(tilemap + 12, 2);
    px_fuzz_put32(tilemap + 16, 2);
    px_fuzz_put32(tilemap + 20, 2);
    px_fuzz_put32(tilemap + 24, PX_FUZZ_IMAGE);
    px_fuzz_put32(tilemap + 28, (uint32_t)sizeof(tilemap));
    tilemap[PX_HEADER_BYTES + 2] = 1;
    tilemap[PX_HEADER_BYTES + 4] = 0xFF;
    tilemap[PX_HEADER_BYTES + 5] = 0xFF;
    tilemap[PX_HEADER_BYTES + 6] = 3;
    uint8_t font[PX_HEADER_BYTES + 16] = {0};
    memcpy(font, "PXFN", 4);
    px_fuzz_put32(font + 4, PX_FONT_VERSION);
    px_fuzz_put32(font + 8, 8);
    px_fuzz_put32(font + 12, 8);
    px_fuzz_put32(font + 16, 'A');
    px_fuzz_put32(font + 20, 2);
    px_fuzz_put32(font + 24, 'A');
    px_fuzz_put32(font + 28, (uint32_t)sizeof(font));
    for (size_t index = 0; index < 16; ++index) {
        font[PX_HEADER_BYTES + index] = (uint8_t)(0x81U << (index % 3));
    }
    if (px_fuzz_upload(context, PX_IMAGE_KIND, image, sizeof(image)) != PX_FUZZ_IMAGE ||
        px_fuzz_upload(context, PX_TILEMAP_KIND, tilemap, sizeof(tilemap)) != PX_FUZZ_TILEMAP ||
        px_fuzz_upload(context, PX_FONT_KIND, font, sizeof(font)) != PX_FUZZ_FONT) {
        abort();
    }
    return context;
}

#endif
