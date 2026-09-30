// Test-only AudioWorklet module: starts normally, then reports an error.
// Worklet scopes have no timers, so the failure is raised from process().
class LateFailureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.calls = -1;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'init') return;
      this.port.postMessage({ type: 'ready', version: 1 });
      this.calls = 0;
    };
  }
  process() {
    if (this.calls >= 0 && ++this.calls === 8)
      this.port.postMessage({ type: 'error', message: 'intentional late failure' });
    return true;
  }
}
registerProcessor('pixeljs-audio-processor', LateFailureProcessor);
