// Benchmark-only AudioWorklet module (B12): it starts normally, acknowledges
// batches without playing them, and after 32 render quanta (about 85 ms at
// 48 kHz) reports a processor error, as a trapped DSP would.
class FailingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.quanta = -1;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'init') {
        this.port.postMessage({ type: 'ready', version: 3 });
        this.quanta = 0;
      } else if (message?.type === 'batch') {
        this.port.postMessage({
          type: 'ack',
          epoch: message.epoch,
          sequence: message.sequence,
          accepted: 0,
        });
      }
    };
  }

  process(_inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0);
    if (this.quanta >= 0 && ++this.quanta === 32)
      this.port.postMessage({ type: 'error', message: 'benchmark processor failure' });
    return true;
  }
}

registerProcessor('pixeljs-audio-processor', FailingProcessor);
