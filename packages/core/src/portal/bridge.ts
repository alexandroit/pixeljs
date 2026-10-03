import type {
  GameOverResult,
  Launch,
  LevelEndResult,
  LevelProgress,
  LevelResult,
  LoadResult,
  MultiplayerResult,
  PlayerInfo,
  Portal,
  PortalOptions,
  PortalState,
  RoomResult,
  SaveResult,
  UnlockResult,
} from './types.js';

/** The version of the portal protocol (`pjs: 2`) this bridge speaks. */
export const BRIDGE_VERSION = '2.0.0';

const REPLY_TIMEOUT = 15000;
const NONCE = /[#&]pjs=([A-Za-z0-9_-]{16,64})/;

type Data = Record<string, unknown>;
type Handler = (data: never) => void;

function errorCode(reply: Data): string | undefined {
  const error = reply['error'];
  const code = error !== null && typeof error === 'object' ? (error as Data)['code'] : undefined;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/**
 * Connects the game to the PixelJS portal: levels, scores, achievements, saves,
 * online play and the portal's pause, resume and mute controls. Inside the portal
 * it resolves once the portal answers (or after `timeoutMs`); anywhere else it
 * resolves at once with `inPortal` false, and every call still answers, so the same
 * build runs on any site.
 */
export function connectPortal(options: PortalOptions = {}): Promise<Portal> {
  const view = typeof window === 'undefined' ? undefined : window;
  const nonce = (view && NONCE.exec(view.location.hash)?.[1]) || '';
  // The portal runs the game in a frame and passes a nonce in the URL fragment.
  const parent = view && nonce && view.parent !== view ? view.parent : undefined;
  const handlers = new Map<string, Set<Handler>>();
  const pending = new Map<string, (reply: Data) => void>();
  const memory = new Map<string, { data: string; rev: number }>();
  let seq = 0;
  let current = '';
  let inPortal = false;
  let capabilities: readonly string[] = [];
  let launch: Launch = { mode: 'solo' };

  /** Posts a message to the portal; a request's `id` comes back as the reply's `re`. */
  function send(type: string, data: unknown, id?: string): void {
    parent?.postMessage({ pjs: 2, type, nonce, id, data }, '*');
  }

  function request(type: string, data: unknown): Promise<Data> {
    const id = `m${++seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: { code: 'unavailable' } });
      }, REPLY_TIMEOUT);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(
          reply && typeof reply === 'object' ? reply : { ok: false, error: { code: 'invalid' } },
        );
      });
      send(type, data, id);
    });
  }

  function on(event: string, handler: Handler): () => void {
    let set = handlers.get(event);
    if (!set) handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => void handlers.get(event)?.delete(handler);
  }

  function emit(event: string, data: Data): void {
    for (const handler of handlers.get(event) ?? []) {
      try {
        handler(data as never);
      } catch (error) {
        // A failing handler must not stop the others; its error still surfaces.
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  async function levelEnd(run: string, result: LevelResult): Promise<LevelEndResult> {
    if (run === current) current = '';
    if (!inPortal) return { recorded: false, reason: 'not_in_portal' };
    if (!run || run.startsWith('failed-')) return { recorded: false, reason: 'no_active_run' };
    const reply = await request('level.end', { run, ...result });
    return reply['ok']
      ? (reply as unknown as LevelEndResult)
      : { recorded: false, reason: errorCode(reply) ?? 'unavailable' };
  }

  async function multiplayerRequest(type: string, data: Data): Promise<RoomResult> {
    if (!inPortal) return { ok: false, reason: 'not_in_portal' };
    const reply = await request(type, data);
    return reply['ok']
      ? (reply as unknown as RoomResult)
      : { ok: false, reason: errorCode(reply) ?? 'unavailable' };
  }

  const portal: Portal = {
    get inPortal() {
      return inPortal;
    },
    get capabilities() {
      return capabilities;
    },
    get launch() {
      return launch;
    },
    on,
    loading(loaded: number, total: number): void {
      send('progress', { loaded, total });
    },
    ready(): void {
      send('ready', {});
    },
    error(message: string): void {
      send('error', { message: String(message).slice(0, 200) });
    },
    state(state: PortalState): void {
      send('state', state);
    },
    async levelStart(level = ''): Promise<string> {
      if (current) await levelEnd(current, { outcome: 'quit' });
      if (!inPortal) return (current = `local-${++seq}`);
      const reply = await request('level.start', level ? { level } : {});
      current = reply['ok'] ? String(reply['run']) : `failed-${++seq}`;
      return current;
    },
    levelEnd,
    async gameOver(result: GameOverResult = {}): Promise<LevelEndResult> {
      if (!current)
        return { recorded: false, reason: inPortal ? 'no_active_run' : 'not_in_portal' };
      return levelEnd(current, { outcome: 'fail', ...result });
    },
    async levels(): Promise<Readonly<Record<string, LevelProgress>>> {
      if (!inPortal) return {};
      const reply = await request('levels.get', {});
      return reply['ok'] ? ((reply['levels'] || {}) as Record<string, LevelProgress>) : {};
    },
    async unlock(id: string): Promise<UnlockResult> {
      if (!inPortal) return { unlocked: false, reason: 'not_in_portal' };
      const reply = await request('achievement.unlock', { id });
      return reply['ok']
        ? { unlocked: Boolean(reply['unlocked']), reason: reply['reason'] as string | undefined }
        : { unlocked: false, reason: errorCode(reply) };
    },
    async save(slot: string, data: string, options: { rev?: number } = {}): Promise<SaveResult> {
      if (!inPortal) {
        const rev = (memory.get(slot)?.rev || 0) + 1;
        memory.set(slot, { data: String(data), rev });
        return { ok: true, rev };
      }
      const reply = await request('save', { slot, data: String(data), rev: options.rev });
      return reply['ok']
        ? { ok: true, rev: reply['rev'] as number }
        : { ok: false, reason: errorCode(reply) ?? 'unavailable' };
    },
    async load(slot: string): Promise<LoadResult> {
      if (!inPortal) {
        const saved = memory.get(slot);
        return { data: saved ? saved.data : null, rev: saved ? saved.rev : 0, schema: 0 };
      }
      const reply = await request('load', { slot });
      return reply['ok']
        ? {
            data: (reply['data'] ?? null) as string | null,
            rev: (reply['rev'] || 0) as number,
            schema: (reply['schema'] || 0) as number,
          }
        : { data: null, rev: 0, schema: 0, reason: errorCode(reply) };
    },
    async player(): Promise<PlayerInfo> {
      if (!inPortal) return { signedIn: false };
      const reply = await request('player.get', {});
      return reply['ok']
        ? { signedIn: Boolean(reply['signedIn']), handle: reply['handle'] as string }
        : { signedIn: false };
    },
    multiplayer: {
      get available() {
        return inPortal && capabilities.includes('multiplayer');
      },
      find(options: { mode?: string } = {}): Promise<RoomResult> {
        return multiplayerRequest('mp.find', { mode: options.mode });
      },
      host(options: { mode?: string } = {}): Promise<RoomResult> {
        return multiplayerRequest('mp.host', { mode: options.mode });
      },
      join(code: string): Promise<RoomResult> {
        return multiplayerRequest('mp.join', { code: String(code) });
      },
      start(): Promise<MultiplayerResult> {
        return multiplayerRequest('mp.start', {});
      },
      ready(ready = true): void {
        send('mp.ready', { ready: Boolean(ready) });
      },
      send(data: unknown, options: { to?: number } = {}): void {
        send('mp.send', { data, to: options.to });
      },
      result(placements: readonly number[]): Promise<MultiplayerResult> {
        return multiplayerRequest('mp.result', { placements });
      },
      leave(): void {
        send('mp.leave', {});
      },
      on(event: string, handler: Handler): () => void {
        return on(`mp.${event}`, handler);
      },
    },
  };

  if (!view || !parent) return Promise.resolve(portal);

  view.addEventListener('message', (event) => {
    const message: unknown = event.data;
    if (event.source !== parent || !message || typeof message !== 'object') return;
    const { pjs, type, nonce: key, data: body, re } = message as Data;
    if (key !== nonce || pjs !== 2 || typeof type !== 'string') return;
    const data = (body && typeof body === 'object' ? body : {}) as Data;
    if (type === 'reply') {
      const done = pending.get(re as string);
      if (done) {
        pending.delete(re as string);
        done(data);
      }
      return;
    }
    if (type === 'welcome') {
      inPortal = true;
      const granted = data['capabilities'];
      capabilities = Array.isArray(granted)
        ? granted.filter((name): name is string => typeof name === 'string')
        : [];
      const chosen = data['launch'];
      if (chosen && typeof chosen === 'object' && typeof (chosen as Data)['mode'] === 'string')
        launch = chosen as Launch;
    }
    emit(type, data);
  });

  // The portal counts a play when the player first interacts with the game.
  const capture = { capture: true };
  const interacted = (): void => {
    send('interaction', {});
    view.removeEventListener('keydown', interacted, capture);
    view.removeEventListener('pointerdown', interacted, capture);
  };
  view.addEventListener('keydown', interacted, capture);
  view.addEventListener('pointerdown', interacted, capture);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(portal), options.timeoutMs ?? 3000);
    const stop = on('welcome', () => {
      clearTimeout(timeout);
      stop();
      resolve(portal);
    });
    send('hello', {
      bridge: BRIDGE_VERSION,
      engine: options.engine,
      capabilities: options.capabilities || [],
    });
  });
}
