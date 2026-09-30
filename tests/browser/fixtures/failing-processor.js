// Test-only AudioWorklet module: the processor fails in its constructor.
class FailingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    throw new Error('Intentional test failure during processor construction.');
  }
  process() {
    return true;
  }
}
registerProcessor('pixeljs-audio-processor', FailingProcessor);
