/** Private Emscripten interface. Never returned from the public facade. */
export interface WasmModule {
  HEAPU8: Uint8Array;
  _pxw_abi_version(): number;
  _pxw_initialize(width: number, height: number, paletteCount: number): number;
  _pxw_mailbox_offset(): number;
  _pxw_mailbox_capacity(): number;
  _pxw_submit(length: number): number;
  _pxw_upload_begin(kind: number, length: number): number;
  _pxw_upload_chunk(length: number): number;
  _pxw_upload_commit(): number;
  _pxw_upload_abort(): number;
  _pxw_last_resource_handle(): number;
  _pxw_resource_release(handle: number): number;
  _pxw_frame_offset(): number;
  _pxw_frame_stride(): number;
  _pxw_palette_offset(): number;
  _pxw_rgba_offset(): number;
  _pxw_expand_rgba(): number;
  _pxw_last_error_code(): number;
  _pxw_last_error_command_index(): number;
  _pxw_last_error_byte_offset(): number;
  _pxw_live_bytes(): number;
  _pxw_allocation_count(): number;
  _pxw_destroy(): number;
  _pxw_resize(width: number, height: number): number;
  _pxw_set_palette(paletteCount: number): number;
  _pxw_palette_count(): number;
  _pxw_palette_revision(): number;
}
