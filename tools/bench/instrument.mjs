// Injected into every benchmark page before its own scripts (Playwright
// addInitScript). It observes and never changes behavior: WebAssembly
// instantiation time, AudioContext lifetimes, canvas contexts created and
// the audio transport's MessagePort traffic. Written as a plain script (no
// imports or exports) so it can be injected as is.
(() => {
  const now = () => performance.now();
  const state = {
    wasm: [],
    audioContexts: [],
    posts: [],
    acks: [],
    contexts: { webgl2: 0, '2d': 0 },
  };
  window.__pixeljsBench = state;
  /** Clears the transport records between phases. */
  state.resetTransport = () => {
    state.posts.length = 0;
    state.acks.length = 0;
  };

  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (source, imports) {
    const start = now();
    const bytes =
      source instanceof ArrayBuffer || ArrayBuffer.isView(source) ? source.byteLength : null;
    return instantiate.call(this, source, imports).then((result) => {
      state.wasm.push({ start, ms: now() - start, bytes });
      return result;
    });
  };

  const Original = window.AudioContext;
  if (typeof Original === 'function') {
    // A WeakRef keeps observation from extending the context's lifetime.
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args);
        state.audioContexts.push({ created: now(), ref: new WeakRef(this) });
      }
    };
  }

  const getContext = HTMLCanvasElement.prototype.getContext;
  const counted = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = getContext.call(this, type, ...rest);
    if (context && !counted.has(context) && type in state.contexts) {
      counted.add(context);
      state.contexts[type]++;
    }
    return context;
  };

  // The audio transport: batches and stops posted to the processor, and the
  // acknowledgements, errors and music ends it sends back. Incoming messages
  // are recorded by wrapping the `onmessage` handler the controller installs,
  // so each is timestamped before the controller reacts to it (an ACK can
  // post the next batch at once) and no extra event listener is added.
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    const type = message?.type;
    if ((type === 'batch' || type === 'stop' || type === 'init') && state.posts.length < 50000)
      state.posts.push({
        t: now(),
        type,
        epoch: message.epoch,
        sequence: message.sequence,
        events: type === 'batch' ? message.events : null,
      });
    return post.call(this, message, ...rest);
  };
  const handler = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  if (handler?.set) {
    const wrapped = new WeakMap();
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      configurable: true,
      enumerable: handler.enumerable,
      get() {
        const current = handler.get.call(this);
        return wrapped.get(current) ?? current;
      },
      set(listener) {
        if (typeof listener !== 'function') {
          handler.set.call(this, listener);
          return;
        }
        const observe = function (event) {
          const data = event.data;
          if (
            data &&
            typeof data === 'object' &&
            typeof data.type === 'string' &&
            state.acks.length < 50000
          )
            state.acks.push({
              t: now(),
              type: data.type,
              epoch: data.epoch,
              sequence: data.sequence,
              accepted: data.accepted,
            });
          return listener.call(this, event);
        };
        wrapped.set(observe, listener);
        handler.set.call(this, observe);
      },
    });
  }
})();
