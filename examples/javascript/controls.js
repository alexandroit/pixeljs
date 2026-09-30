// The host maps buttons and swipes to the same buffered game directions as keys.
// No renderer, heap view, synthetic keyboard event, or private engine API is used.
export function bindGameControls(canvas, root, getGame) {
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  let swipe;

  function direction(value) {
    const game = getGame();
    if (!game || game.engine.state !== 'RUNNING') return;
    game.setDirection(value);
    canvas.focus({ preventScroll: true });
  }

  for (const button of root.querySelectorAll('[data-direction]')) {
    const value = button.dataset.direction;
    if (!['up', 'down', 'left', 'right'].includes(value)) continue;
    button.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        direction(value);
      },
      options,
    );
    button.addEventListener(
      'click',
      (event) => {
        if (event.detail === 0) direction(value);
      },
      options,
    );
  }

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    options,
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (!swipe || swipe.id !== event.pointerId) return;
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 14) return;
      direction(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
      swipe.x = event.clientX;
      swipe.y = event.clientY;
    },
    options,
  );
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(
      name,
      (event) => {
        if (swipe?.id === event.pointerId) swipe = undefined;
      },
      options,
    );
  }
  return () => {
    swipe = undefined;
    lifetime.abort();
  };
}

// Browsers start audio only from a user gesture, so the first key press, tap
// or click starts the current game's audio. A game created later (a restart
// with a new engine) starts with the next gesture.
export function unlockAudioOnGesture(root, getGame) {
  const lifetime = new AbortController();
  let pending = false;
  const unlock = () => {
    const game = getGame();
    const state = game?.engine.audio.capabilities.state;
    if (pending || (state !== 'uninitialized' && state !== 'blocked')) return;
    pending = true;
    game
      .unlockAudio()
      .catch(() => {
        /* Blocked or unsupported: the game plays silently; a later gesture retries. */
      })
      .finally(() => {
        pending = false;
      });
  };
  for (const type of ['keydown', 'pointerdown'])
    root.addEventListener(type, unlock, { capture: true, signal: lifetime.signal });
  return () => lifetime.abort();
}
