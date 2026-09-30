// Benchmark-only AudioWorklet module (B12): it completes the startup
// handshake like the real processor, then never reads its port again, so no
// batch is consumed and no acknowledgement ever returns. Output is silence.
class StallProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'init') return;
      this.port.postMessage({ type: 'ready', version: 3 });
      this.port.onmessage = null;
    };
  }

  process(_inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}

registerProcessor('pixeljs-audio-processor', StallProcessor);
