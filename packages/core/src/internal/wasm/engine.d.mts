import type { WasmModule } from './module.js';
export default function createModule(options: {
  wasmBinary: Uint8Array;
  printErr?: (message: string) => void;
}): Promise<WasmModule>;
