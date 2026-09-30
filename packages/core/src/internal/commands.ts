import { PixelJSError } from '../api/errors.js';
import { OPCODE, PROTOCOL } from './protocol.js';
import type { WasmAdapter } from './wasm/adapter.js';

export class CommandWriter {
  count = 0;
  constructor(private readonly core: WasmAdapter) {}
  begin(sequence: number): void {
    const view = this.core.mailbox;
    this.count = 0;
    view.setUint32(0, 0x534a5850, true);
    view.setUint32(4, PROTOCOL.protocolVersion, true);
    view.setUint32(8, 0, true);
    view.setUint32(12, PROTOCOL.headerBytes, true);
    view.setUint32(16, sequence % 0x100000000, true);
    view.setUint32(20, 0, true);
    view.setUint32(24, 0, true);
    view.setUint32(28, 0, true);
  }
  write(opcode: number, handle = 0, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, flags = 0): void {
    if (this.count >= PROTOCOL.maxCommands)
      throw new PixelJSError('CAPACITY', 'The draw callback exceeded 4096 commands.');
    const at = PROTOCOL.headerBytes + this.count * PROTOCOL.recordBytes;
    const view = this.core.mailbox;
    view.setUint16(at, opcode, true);
    view.setUint16(at + 2, flags, true);
    view.setUint32(at + 4, handle, true);
    view.setInt32(at + 8, a, true);
    view.setInt32(at + 12, b, true);
    view.setInt32(at + 16, c, true);
    view.setInt32(at + 20, d, true);
    view.setInt32(at + 24, e, true);
    view.setInt32(at + 28, f, true);
    this.count++;
  }
  /** Writes a command and the PARAMS record that must directly follow it. */
  writeWithParams(
    opcode: number,
    handle: number,
    args: readonly [number, number, number, number, number, number],
    flags: number,
    params: readonly number[],
  ): void {
    if (this.count + 2 > PROTOCOL.maxCommands)
      throw new PixelJSError('CAPACITY', 'The draw callback exceeded 4096 commands.');
    this.write(opcode, handle, ...args, flags);
    this.write(OPCODE.PARAMS, 0, params[0], params[1], params[2], params[3], params[4], params[5]);
  }
  submit(): void {
    const length = PROTOCOL.headerBytes + this.count * PROTOCOL.recordBytes;
    this.core.mailbox.setUint32(8, this.count, true);
    this.core.mailbox.setUint32(12, length, true);
    this.core.submit(length);
  }
}
