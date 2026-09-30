import { PixelJSError } from '../../api/errors.js';
import { fetchLimited } from '../fetch.js';
import { PROTOCOL, STATUS } from '../protocol.js';
import type { WasmModule } from './module.js';

const WASM_LIMIT = 8 * 1024 * 1024;
const statusNames = new Map<number, string>(
  Object.entries(STATUS).map(([name, value]) => [value, name]),
);

/** Downloads a bounded WASM binary served as application/wasm. */
export async function readBinary(url: URL, signal: AbortSignal): Promise<Uint8Array> {
  const { bytes } = await fetchLimited(url, {
    limit: WASM_LIMIT,
    code: 'WASM_LOAD',
    signal,
    expectType: {
      mime: 'application/wasm',
      code: 'WASM_MIME',
      message: 'Serve the WASM binary with Content-Type: application/wasm.',
    },
  });
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109)
    throw new PixelJSError('WASM_LOAD', 'The response is not a WebAssembly binary.');
  return bytes;
}

export class WasmAdapter {
  private module: WasmModule | null;
  mailbox: DataView;
  mailboxBytes: Uint8Array;
  indexed: Uint8Array;
  /** All 256 RGBA entries; indices at or beyond paletteCount are never drawn. */
  palette: Uint8Array;
  rgba: Uint8Array;
  readonly paletteCount: number;

  constructor(module: WasmModule, width: number, height: number, colors?: Uint8Array) {
    this.module = module;
    if (module._pxw_abi_version() !== PROTOCOL.abiVersion) {
      module._pxw_destroy();
      throw new PixelJSError('ABI_MISMATCH', 'JavaScript and WASM ABI versions do not match.');
    }
    this.paletteCount = colors ? colors.byteLength / 4 : 16;
    this.check(module._pxw_initialize(width, height, this.paletteCount));
    if (
      module._pxw_mailbox_capacity() !== PROTOCOL.mailboxBytes ||
      module._pxw_frame_stride() !== width ||
      module._pxw_palette_count() !== this.paletteCount
    ) {
      this.destroy();
      throw new PixelJSError('ABI_MISMATCH', 'WASM memory layout does not match the SDK.');
    }
    this.mailboxBytes = this.view(module._pxw_mailbox_offset(), PROTOCOL.mailboxBytes);
    this.mailbox = new DataView(
      this.mailboxBytes.buffer,
      this.mailboxBytes.byteOffset,
      this.mailboxBytes.byteLength,
    );
    this.indexed = this.view(module._pxw_frame_offset(), width * height);
    this.palette = this.view(module._pxw_palette_offset(), PROTOCOL.maxPaletteColors * 4);
    this.rgba = this.view(module._pxw_rgba_offset(), width * height * 4);
    if (colors) {
      try {
        this.setPalette(colors);
      } catch (error) {
        this.destroy();
        throw error;
      }
    }
  }

  private view(raw: number, length: number): Uint8Array {
    const heap = this.alive().HEAPU8;
    // Only trusted ABI getters reach this normalization; no public number is an address.
    const offset = raw >>> 0;
    if (offset > heap.byteLength || length > heap.byteLength - offset) {
      throw new PixelJSError('ABI_MISMATCH', 'WASM returned an invalid private buffer range.');
    }
    return new Uint8Array(heap.buffer, offset, length);
  }
  private alive(): WasmModule {
    if (!this.module) throw new PixelJSError('STATE', 'The WASM instance has been destroyed.');
    return this.module;
  }
  private check(status: number): void {
    if (status === STATUS.OK) return;
    const mod = this.alive();
    const index = mod._pxw_last_error_command_index() >>> 0;
    const offset = mod._pxw_last_error_byte_offset() >>> 0;
    throw new PixelJSError(
      statusNames.get(status) ?? 'INTERNAL',
      `Core rejected operation (${statusNames.get(status) ?? status}; command ${index === PROTOCOL.noCommand ? 'none' : index}, byte ${offset === PROTOCOL.noCommand ? 'none' : offset}).`,
    );
  }
  submit(length: number): void {
    this.check(this.alive()._pxw_submit(length));
  }
  expand(): void {
    this.check(this.alive()._pxw_expand_rgba());
  }
  upload(kind: number, data: Uint8Array): number {
    const mod = this.alive();
    this.check(mod._pxw_upload_begin(kind, data.byteLength));
    try {
      for (let offset = 0; offset < data.byteLength; offset += PROTOCOL.mailboxBytes) {
        const chunk = data.subarray(
          offset,
          Math.min(data.byteLength, offset + PROTOCOL.mailboxBytes),
        );
        this.mailboxBytes.set(chunk);
        this.check(mod._pxw_upload_chunk(chunk.byteLength));
      }
      this.check(mod._pxw_upload_commit());
      const handle = mod._pxw_last_resource_handle() >>> 0;
      if (handle === 0) throw new PixelJSError('INTERNAL', 'Core did not publish the resource.');
      return handle;
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) this.abandon();
      else mod._pxw_upload_abort();
      throw error;
    }
  }
  resize(width: number, height: number): void {
    const mod = this.alive();
    this.check(mod._pxw_resize(width, height));
    this.indexed = this.view(mod._pxw_frame_offset(), width * height);
    this.rgba = this.view(mod._pxw_rgba_offset(), width * height * 4);
  }
  /** rgba holds exactly paletteCount opaque entries; the core validates again. */
  setPalette(rgba: Uint8Array): void {
    const mod = this.alive();
    this.mailboxBytes.set(rgba);
    this.check(mod._pxw_set_palette(rgba.byteLength / 4));
  }
  /** Increases whenever any palette entry changes, including batch records. */
  get paletteRevision(): number {
    return this.alive()._pxw_palette_revision() >>> 0;
  }
  /** Copies the indexed framebuffer, into `target` when it has exactly the frame's length. */
  copyFrame(target?: Uint8Array): Uint8Array {
    this.alive();
    const copy =
      target !== undefined && target.length === this.indexed.length
        ? target
        : new Uint8Array(this.indexed.length);
    copy.set(this.indexed);
    return copy;
  }
  /** Copies all 256 RGBA palette entries. */
  copyPalette(): Uint8Array {
    this.alive();
    return this.palette.slice();
  }
  release(handle: number): void {
    this.check(this.alive()._pxw_resource_release(handle));
  }
  get bytes(): number {
    return this.alive()._pxw_live_bytes() >>> 0;
  }
  get allocations(): number {
    return this.alive()._pxw_allocation_count() >>> 0;
  }
  destroy(): void {
    if (this.module) {
      this.module._pxw_destroy();
    }
    this.abandon();
  }
  /** A trapped module is never called again; release heap references for host GC. */
  abandon(): void {
    this.module = null;
    this.mailboxBytes = new Uint8Array(0);
    this.mailbox = new DataView(this.mailboxBytes.buffer);
    this.indexed = new Uint8Array(0);
    this.palette = new Uint8Array(0);
    this.rgba = new Uint8Array(0);
  }
}

export async function loadWasm(
  width: number,
  height: number,
  wasmUrl?: string | URL,
  signal?: AbortSignal,
  colors?: Uint8Array,
): Promise<WasmAdapter> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('WASM loading timed out.')), 30_000);
  let module: WasmModule | undefined;
  try {
    const url =
      wasmUrl === undefined
        ? new URL('./engine.wasm', import.meta.url)
        : new URL(wasmUrl, document.baseURI);
    const binary = await readBinary(url, controller.signal);
    const { default: factory } = await import('./engine.mjs');
    if (controller.signal.aborted) throw controller.signal.reason;
    module = await factory({ wasmBinary: binary });
    if (controller.signal.aborted) throw controller.signal.reason;
    return new WasmAdapter(module, width, height, colors);
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) module?._pxw_destroy();
    if (error instanceof PixelJSError && error.code !== 'ABORTED') throw error;
    throw new PixelJSError(
      controller.signal.aborted ? 'ABORTED' : 'WASM_LOAD',
      controller.signal.aborted
        ? 'Engine creation was cancelled or timed out.'
        : 'Could not load the engine WASM binary.',
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
