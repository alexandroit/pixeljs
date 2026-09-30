#include "internal.h"
#include <assert.h>
#include <string.h>

static void px_decode_command(const uint8_t *bytes, px_command *command) {
    command->opcode = px_read_u16(bytes);
    command->flags = px_read_u16(bytes + 2);
    command->handle = px_read_u32(bytes + 4);
    for (size_t index = 0; index < 6; ++index) {
        command->args[index] = px_read_i32(bytes + 8 + index * 4);
    }
}

static bool px_reserved_zero(const px_command *command, size_t first) {
    for (size_t index = first; index < 6; ++index) {
        if (command->args[index] != 0) {
            return false;
        }
    }
    return true;
}

static bool px_valid_color(const px_context *context, int32_t color) {
    return color >= 0 && (uint32_t)color < context->config.palette_count;
}

static bool px_valid_channel(int32_t value) {
    return value >= 0 && value <= 255;
}

static bool px_params_zero(const px_command *command, size_t first) {
    for (size_t index = first; index < 6; ++index) {
        if (command->params[index] != 0) {
            return false;
        }
    }
    return true;
}

bool px_opcode_has_params(uint16_t opcode) {
    return opcode == PX_OP_TRIANGLE || opcode == PX_OP_TRIANGLE_FILL ||
           opcode == PX_OP_BLIT_TRANSFORM;
}

static px_result px_validate_command(const px_context *context, const px_command *command,
                                     const px_resource_slot **out_resource) {
    *out_resource = NULL;
    if (command->opcode == PX_OP_BLIT_TRANSFORM) {
        if ((command->flags & (uint16_t)~(PX_FLAG_FLIP_X | PX_FLAG_FLIP_Y)) != 0 ||
            !px_params_zero(command, 2)) {
            return PX_ERR_PROTOCOL;
        }
        *out_resource = px_find_image(context, command->handle);
        if (*out_resource == NULL) {
            return PX_ERR_HANDLE;
        }
        /* The source rectangle must lie in the image; params hold the
         * rotation in 1/4096 turns and the scale in 1/65536 units. */
        const px_resource_slot *image = *out_resource;
        return command->args[2] >= 0 && command->args[3] >= 0 && command->args[4] >= 0 &&
                       command->args[5] >= 0 &&
                       (uint64_t)command->args[2] + (uint64_t)command->args[4] <= image->width &&
                       (uint64_t)command->args[3] + (uint64_t)command->args[5] <= image->height &&
                       command->params[0] >= 0 && (uint32_t)command->params[0] < PX_ANGLE_UNITS &&
                       command->params[1] >= 0 && (uint32_t)command->params[1] >= PX_MIN_SCALE &&
                       (uint32_t)command->params[1] <= PX_MAX_SCALE
                   ? PX_OK
                   : PX_ERR_RANGE;
    }
    if (command->opcode == PX_OP_BLIT) {
        if ((command->flags & (uint16_t)~(PX_FLAG_FLIP_X | PX_FLAG_FLIP_Y)) != 0) {
            return PX_ERR_PROTOCOL;
        }
        *out_resource = px_find_image(context, command->handle);
        if (*out_resource == NULL) {
            return PX_ERR_HANDLE;
        }
        return command->args[4] >= 0 && command->args[5] >= 0 ? PX_OK : PX_ERR_RANGE;
    }
    if (command->opcode == PX_OP_TILEMAP) {
        if (command->flags != 0) {
            return PX_ERR_PROTOCOL;
        }
        *out_resource = px_find_tilemap(context, command->handle);
        if (*out_resource == NULL) {
            return PX_ERR_HANDLE;
        }
        return command->args[2] >= 0 && command->args[3] >= 0 && command->args[4] >= 0 &&
                       command->args[5] >= 0
                   ? PX_OK
                   : PX_ERR_RANGE;
    }
    if (command->opcode == PX_OP_GLYPH) {
        if (command->flags != 0 || !px_reserved_zero(command, 5)) {
            return PX_ERR_PROTOCOL;
        }
        if (command->handle != 0) {
            *out_resource = px_find_font(context, command->handle);
            if (*out_resource == NULL) {
                return PX_ERR_HANDLE;
            }
        }
        /* The background is either -1 (transparent) or a palette index. */
        const int32_t background = command->args[4];
        return command->args[2] >= 0 && (uint32_t)command->args[2] <= PX_MAX_CHAR_CODE &&
                       px_valid_color(context, command->args[3]) &&
                       (background == -1 || px_valid_color(context, background))
                   ? PX_OK
                   : PX_ERR_RANGE;
    }
    if (command->flags != 0 || command->handle != 0) {
        return PX_ERR_PROTOCOL;
    }
    switch (command->opcode) {
    case PX_OP_CLEAR:
        if (!px_reserved_zero(command, 1))
            return PX_ERR_PROTOCOL;
        return px_valid_color(context, command->args[0]) ? PX_OK : PX_ERR_RANGE;
    case PX_OP_RECT:
    case PX_OP_RECTB:
        if (!px_reserved_zero(command, 5))
            return PX_ERR_PROTOCOL;
        return command->args[2] >= 0 && command->args[3] >= 0 &&
                       px_valid_color(context, command->args[4])
                   ? PX_OK
                   : PX_ERR_RANGE;
    case PX_OP_PIXEL:
        if (!px_reserved_zero(command, 3))
            return PX_ERR_PROTOCOL;
        return px_valid_color(context, command->args[2]) ? PX_OK : PX_ERR_RANGE;
    case PX_OP_LINE:
        if (!px_reserved_zero(command, 5))
            return PX_ERR_PROTOCOL;
        return px_valid_color(context, command->args[4]) ? PX_OK : PX_ERR_RANGE;
    case PX_OP_CIRCLE:
    case PX_OP_CIRCLE_FILL:
        if (!px_reserved_zero(command, 4))
            return PX_ERR_PROTOCOL;
        return command->args[2] >= 0 && px_valid_color(context, command->args[3]) ? PX_OK
                                                                                   : PX_ERR_RANGE;
    case PX_OP_ELLIPSE:
    case PX_OP_ELLIPSE_FILL:
        if (!px_reserved_zero(command, 5))
            return PX_ERR_PROTOCOL;
        return command->args[2] >= 0 && (uint32_t)command->args[2] <= PX_MAX_ELLIPSE_DIMENSION &&
                       command->args[3] >= 0 &&
                       (uint32_t)command->args[3] <= PX_MAX_ELLIPSE_DIMENSION &&
                       px_valid_color(context, command->args[4])
                   ? PX_OK
                   : PX_ERR_RANGE;
    case PX_OP_TRIANGLE:
    case PX_OP_TRIANGLE_FILL:
        if (!px_params_zero(command, 1))
            return PX_ERR_PROTOCOL;
        return px_valid_color(context, command->params[0]) ? PX_OK : PX_ERR_RANGE;
    case PX_OP_FILL:
        if (!px_reserved_zero(command, 3))
            return PX_ERR_PROTOCOL;
        return px_valid_color(context, command->args[2]) ? PX_OK : PX_ERR_RANGE;
    case PX_OP_SET_REMAP:
        if (!px_reserved_zero(command, 2))
            return PX_ERR_PROTOCOL;
        return px_valid_color(context, command->args[0]) && px_valid_color(context, command->args[1])
                   ? PX_OK
                   : PX_ERR_RANGE;
    case PX_OP_RESET_REMAP:
        return px_reserved_zero(command, 0) ? PX_OK : PX_ERR_PROTOCOL;
    case PX_OP_PARAMS:
        /* Only valid directly after an opcode that declares it. */
        return PX_ERR_PROTOCOL;
    case PX_OP_SET_PALETTE:
        if (!px_reserved_zero(command, 4))
            return PX_ERR_PROTOCOL;
        return px_valid_color(context, command->args[0]) && px_valid_channel(command->args[1]) &&
                       px_valid_channel(command->args[2]) && px_valid_channel(command->args[3])
                   ? PX_OK
                   : PX_ERR_RANGE;
    case PX_OP_SET_CLIP:
        if (!px_reserved_zero(command, 4))
            return PX_ERR_PROTOCOL;
        return command->args[2] >= 0 && command->args[3] >= 0 ? PX_OK : PX_ERR_RANGE;
    case PX_OP_RESET_CLIP:
        return px_reserved_zero(command, 0) ? PX_OK : PX_ERR_PROTOCOL;
    case PX_OP_SET_CAMERA:
        return px_reserved_zero(command, 2) ? PX_OK : PX_ERR_PROTOCOL;
    default:
        return PX_ERR_UNSUPPORTED;
    }
}

static px_result px_batch_error(px_context *context, px_result result, uint32_t command_index,
                                uint32_t byte_offset) {
    (void)px_finish(context, result);
    context->diagnostic.command_index = command_index;
    context->diagnostic.byte_offset = byte_offset;
    return result;
}

static px_result px_validate_header(px_context *context, const uint8_t *bytes, size_t length,
                                    uint32_t *out_count) {
    *out_count = 0;
    if (bytes == NULL) {
        return px_batch_error(context, PX_ERR_ARGUMENT, PX_NO_COMMAND, PX_NO_COMMAND);
    }
    if (length < PX_HEADER_BYTES || length > PX_MAILBOX_BYTES) {
        return px_batch_error(context, PX_ERR_CAPACITY, PX_NO_COMMAND, PX_NO_COMMAND);
    }
    if (memcmp(bytes, "PXJS", 4) != 0) {
        return px_batch_error(context, PX_ERR_PROTOCOL, PX_NO_COMMAND, 0);
    }
    if (px_read_u32(bytes + 4) != PX_PROTOCOL_VERSION) {
        return px_batch_error(context, PX_ERR_PROTOCOL, PX_NO_COMMAND, 4);
    }
    const uint32_t count = px_read_u32(bytes + 8);
    if (count > PX_MAX_COMMANDS) {
        return px_batch_error(context, PX_ERR_CAPACITY, PX_NO_COMMAND, 8);
    }
    const size_t expected = PX_HEADER_BYTES + (size_t)count * PX_RECORD_BYTES;
    if (expected != length || px_read_u32(bytes + 12) != length) {
        return px_batch_error(context, PX_ERR_PROTOCOL, PX_NO_COMMAND, 12);
    }
    for (uint32_t offset = 20; offset < PX_HEADER_BYTES; offset += 4) {
        if (px_read_u32(bytes + offset) != 0) {
            return px_batch_error(context, PX_ERR_PROTOCOL, PX_NO_COMMAND, offset);
        }
    }
    *out_count = count;
    return PX_OK;
}

static bool px_is_state_command(uint16_t opcode) {
    return opcode == PX_OP_SET_CLIP || opcode == PX_OP_RESET_CLIP || opcode == PX_OP_SET_CAMERA ||
           opcode == PX_OP_SET_REMAP || opcode == PX_OP_RESET_REMAP;
}

/* Decodes record `index` and, when its opcode declares one, the PARAMS
 * record after it. Returns the number of records consumed, or 0 when the
 * continuation is missing or malformed. */
static uint32_t px_decode_at(const uint8_t *bytes, uint32_t index, uint32_t count,
                             px_command *command) {
    px_decode_command(bytes + PX_HEADER_BYTES + (size_t)index * PX_RECORD_BYTES, command);
    memset(command->params, 0, sizeof(command->params));
    if (!px_opcode_has_params(command->opcode)) {
        return 1;
    }
    if (index + 1 >= count) {
        return 0;
    }
    px_command params;
    px_decode_command(bytes + PX_HEADER_BYTES + (size_t)(index + 1) * PX_RECORD_BYTES, &params);
    if (params.opcode != PX_OP_PARAMS || params.flags != 0 || params.handle != 0) {
        return 0;
    }
    memcpy(command->params, params.args, sizeof(command->params));
    return 2;
}

px_result px_context_submit(px_context *context, const uint8_t *bytes, size_t length) {
    const px_result entered = px_enter(context);
    if (entered != PX_OK) {
        return entered;
    }
    uint32_t count = 0;
    const px_result header_result = px_validate_header(context, bytes, length, &count);
    if (header_result != PX_OK) {
        return header_result;
    }
    px_draw_state state;
    px_reset_draw_state(context, &state);
    uint64_t work = 0;
    bool changes_palette = false;
    /* Pass one validates every record, resource and the aggregate bounded work
     * without writing context state. The immutable mailbox and resources are
     * exclusively owned for both passes. */
    for (uint32_t index = 0; index < count;) {
        const uint32_t offset = PX_HEADER_BYTES + index * PX_RECORD_BYTES;
        px_command command;
        const uint32_t records = px_decode_at(bytes, index, count, &command);
        if (records == 0) {
            return px_batch_error(context, PX_ERR_PROTOCOL, index, offset);
        }
        const px_resource_slot *resource = NULL;
        const px_result validation = px_validate_command(context, &command, &resource);
        if (validation != PX_OK) {
            return px_batch_error(context, validation, index, offset);
        }
        if (px_is_state_command(command.opcode)) {
            px_apply_state(context, &state, &command);
        } else if (command.opcode == PX_OP_SET_PALETTE) {
            changes_palette = true;
        } else {
            const uint64_t command_work = px_command_work(context, &state, &command, resource);
            if (command_work > PX_MAX_WORK_PIXELS - work) {
                return px_batch_error(context, PX_ERR_CAPACITY, index, offset);
            }
            work += command_work;
        }
        index += records;
    }
    /* Pass two cannot fail, so palette records publish atomically with pixels. */
    px_reset_draw_state(context, &state);
    for (uint32_t index = 0; index < count;) {
        px_command command;
        const uint32_t records = px_decode_at(bytes, index, count, &command);
        assert(records != 0); /* Pass one validated every continuation. */
        index += records != 0 ? records : 1;
        if (px_is_state_command(command.opcode)) {
            px_apply_state(context, &state, &command);
        } else if (command.opcode == PX_OP_SET_PALETTE) {
            px_apply_palette(context, &command);
        } else {
            const px_resource_slot *resource =
                command.handle != 0 ? px_find_resource(context, command.handle) : NULL;
            const uint64_t performed = px_raster_command(context, &state, &command, resource);
            /* Debug builds, fuzzing included, check that admission bounded it. */
            assert(performed <= px_command_work(context, &state, &command, resource));
            (void)performed;
        }
    }
    if (changes_palette) {
        context->palette_revision += 1;
    }
    return px_finish(context, PX_OK);
}
