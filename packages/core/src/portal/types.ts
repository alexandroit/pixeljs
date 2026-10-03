/** A capability a game declares in `pixeljs.json`; the portal grants the ones it reviewed. */
export type PortalCapability =
  'pause' | 'mute' | 'levels' | 'scores' | 'achievements' | 'save' | 'level-select' | 'multiplayer';

/** How a player starts a game: alone, with others on one device, or online. */
export type PlayMode = 'solo' | 'local' | 'online';

/** How the player chose to play, for games that declare several `play_modes`. */
export interface Launch {
  readonly mode: PlayMode;
  /** In `local` mode: how many players share the device. */
  readonly players?: number;
  /** In `online` mode: the code of the room the player was invited to. The portal joins it. */
  readonly room?: string;
}

export interface PortalOptions {
  /** How long to wait for the portal's answer, in milliseconds (default 3000). */
  timeoutMs?: number;
  /**
   * The capabilities `pixeljs.json` declares; the portal grants those it reviewed.
   * Without them, the portal grants every reviewed capability.
   */
  capabilities?: readonly PortalCapability[];
  /** The engine and its version, for example `'@pixeljs/core@0.0.4'`. */
  engine?: string;
}

/** Everything a game learns about the player. */
export interface PlayerInfo {
  readonly signedIn: boolean;
  /** The player's public handle, when signed in. */
  readonly handle?: string;
}

/** A pause or mute the game decided itself, reported with `portal.state()`. */
export interface PortalState {
  paused?: boolean;
  muted?: boolean;
}

/** The end of a run: one attempt at one level. */
export type LevelOutcome = 'complete' | 'fail' | 'quit';

export interface LevelResult {
  outcome: LevelOutcome;
  /** Integers by leaderboard id, within each board's `min` and `max`. */
  scores?: Readonly<Record<string, number>>;
  /** Game time in the level in milliseconds, without pauses. */
  timeMs?: number;
  /** 0 to 3. */
  stars?: number;
  /** Up to 8 numbers for your statistics. */
  stats?: Readonly<Record<string, number>>;
  /** For verified leaderboards: at most 64 KB of JSON, such as a seed and the inputs. */
  replay?: unknown;
}

/** The end of an endless game, always reported as `"fail"`. */
export interface GameOverResult {
  scores?: Readonly<Record<string, number>>;
  timeMs?: number;
  stats?: Readonly<Record<string, number>>;
  replay?: unknown;
}

/** What the portal answered to `levelEnd()` or `gameOver()`. */
export interface LevelEndResult {
  /** False for guests, quits, refused values and outside the portal. */
  readonly recorded: boolean;
  /**
   * Why the run was not recorded: `'not_in_portal'`, `'no_active_run'`, `'guest'`,
   * `'quit'`, `'out_of_bounds'`, `'too_short'`, `'too_fast'`, `'unavailable'`, …
   */
  readonly reason?: string | undefined;
  /** The leaderboards this run improved, by id. */
  readonly newBest?: Readonly<Record<string, boolean>>;
  /** The player's best value on each leaderboard, by id. */
  readonly best?: Readonly<Record<string, number>>;
  /** The player's all-time rank on the default leaderboard. */
  readonly rank?: number;
  /** The achievements this run unlocked. */
  readonly unlocked?: readonly string[];
  /** The result is held for review; the player sees "Under review". */
  readonly held?: boolean;
}

/** The player's progress on one level, from `levels()`. */
export interface LevelProgress {
  readonly completed: boolean;
  readonly stars?: number;
  /** The player's best value on each level leaderboard, by id. */
  readonly best?: Readonly<Record<string, number>>;
  readonly bestTimeMs?: number;
  readonly attempts?: number;
}

export interface UnlockResult {
  readonly unlocked: boolean;
  /** For example `'already'`, `'not_in_portal'` or `'not_granted'`. */
  readonly reason?: string | undefined;
}

/** `{ ok: true, rev }`, or `{ ok: false, reason }` such as `'conflict'` or `'rate_limited'`. */
export type SaveResult =
  { readonly ok: true; readonly rev: number } | { readonly ok: false; readonly reason: string };

export interface LoadResult {
  /** The saved string, or `null` when the slot is empty. */
  readonly data: string | null;
  /** The revision to pass back to `save()`. */
  readonly rev: number;
  /** The `save.schema` of `pixeljs.json` when the data was saved. */
  readonly schema: number;
  /** Why nothing could be loaded, when that happened. */
  readonly reason?: string | undefined;
}

export type RoomState = 'lobby' | 'playing' | 'ended';

export interface RoomPlayer {
  /** The player's number in the room. */
  readonly slot: number;
  readonly handle: string;
  readonly avatar: string;
  readonly ready: boolean;
  readonly connected: boolean;
}

/** A room as its players see it. */
export interface Room {
  /** The invite code of a private room. */
  readonly code: string;
  /** The id of the mode, from the `multiplayer` section of `pixeljs.json`. */
  readonly mode: string;
  readonly private: boolean;
  readonly state: RoomState;
  /** The host's slot. */
  readonly host: number;
  /** This player's slot. */
  readonly me: number;
  readonly min: number;
  readonly max: number;
  readonly players: readonly RoomPlayer[];
}

/** The start of a match: the room and the seed every player received. */
export interface MatchStart extends Room {
  /** A 32-bit seed, the same for every player: use it with `createRandom()`. */
  readonly seed: number;
}

/** Data another player sent with `multiplayer.send()`. Check it before using it. */
export interface MatchMessage {
  readonly from: number;
  readonly data: unknown;
}

export interface PlayerLeft {
  readonly slot: number;
}

export interface MatchEnd {
  /** Why the room closed, such as `'connection'`, `'kicked'` or `'rate_limited'`. */
  readonly reason: string;
}

/** `{ ok: true }`, or `{ ok: false, reason }` such as `'guest'` or `'not_in_portal'`. */
export type MultiplayerResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Like `MultiplayerResult`, with the room when the portal created or joined one. */
export type RoomResult =
  { readonly ok: true; readonly room?: Room } | { readonly ok: false; readonly reason: string };

export interface MultiplayerEvents {
  /** The room changed: players, ready flags, state or host. */
  room: Room;
  /** A match starts. */
  start: MatchStart;
  message: MatchMessage;
  left: PlayerLeft;
  /** The room closed. */
  end: MatchEnd;
}

/** Data the portal sends with an event that has none. */
export type NoData = Readonly<Record<string, never>>;

export interface PortalEvents {
  /** The portal answered `connectPortal()`. */
  welcome: {
    readonly bridge?: string;
    readonly capabilities?: readonly string[];
    readonly launch?: Launch;
  };
  pause: NoData;
  resume: NoData;
  mute: { readonly muted: boolean };
  visibility: { readonly visible: boolean; readonly focused: boolean };
  viewport: {
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
    readonly mode?: string;
  };
  /** A player picked a level in the portal, or opened a link to one (`level-select`). */
  select: { readonly level: string };
  /** The player signed in or out. */
  player: PlayerInfo;
  'mp.room': Room;
  'mp.start': MatchStart;
  'mp.message': MatchMessage;
  'mp.left': PlayerLeft;
  'mp.end': MatchEnd;
}

/** Online play through the portal (capability `multiplayer`). */
export interface Multiplayer {
  /** Whether online play is possible here: inside the portal, with the capability granted. */
  readonly available: boolean;
  /** Quick match: resolves once queued; `room` and `start` events follow. */
  find(options?: { mode?: string }): Promise<RoomResult>;
  /** Creates a private room; the portal shows its invite code and link. */
  host(options?: { mode?: string }): Promise<RoomResult>;
  /** Joins a private room by its code. */
  join(code: string): Promise<RoomResult>;
  /** The host starts the match once enough players are in the room. */
  start(): Promise<MultiplayerResult>;
  /** Marks this player ready in the room (shown in the portal's room screen). */
  ready(ready?: boolean): void;
  /** Sends any JSON value to every other player, or to the player in slot `to`. */
  send(data: unknown, options?: { to?: number }): void;
  /** The host reports the final placements: player slots, best first. */
  result(placements: readonly number[]): Promise<MultiplayerResult>;
  /** Leaves the room or the queue. */
  leave(): void;
  /** Listens to a room event; returns a function that stops listening. */
  on<K extends keyof MultiplayerEvents>(
    event: K,
    handler: (data: MultiplayerEvents[K]) => void,
  ): () => void;
}

/** The connection to the PixelJS portal, from `connectPortal()`. */
export interface Portal {
  /** True inside the PixelJS portal. Outside it every call still resolves. */
  readonly inPortal: boolean;
  /** The capabilities the portal granted (none outside the portal). */
  readonly capabilities: readonly string[];
  /** How the player chose to play; `{ mode: 'solo' }` outside the portal. */
  readonly launch: Launch;
  /** Listens to a portal event; returns a function that stops listening. */
  on<K extends keyof PortalEvents>(event: K, handler: (data: PortalEvents[K]) => void): () => void;
  on(event: string, handler: (data: Readonly<Record<string, unknown>>) => void): () => void;
  /** Loading progress, shown in the portal's loading bar. */
  loading(loaded: number, total: number): void;
  /** The game accepts input: the portal hides its loading screen. */
  ready(): void;
  /** The game cannot run; the portal shows the message (at most 200 characters). */
  error(message: string): void;
  /** Tells the portal about a pause or mute the game decided itself. */
  state(state: PortalState): void;
  /**
   * Starts a run of a level (`"main"` when the game has no levels) and resolves with
   * its id. A run still open is first ended as `"quit"`.
   */
  levelStart(level?: string): Promise<string>;
  /** Ends a run and reports its result. */
  levelEnd(run: string, result: LevelResult): Promise<LevelEndResult>;
  /** Ends the current run as `"fail"`, for endless games. */
  gameOver(result?: GameOverResult): Promise<LevelEndResult>;
  /** The player's progress per level id (`{}` outside the portal). */
  levels(): Promise<Readonly<Record<string, LevelProgress>>>;
  /** Unlocks an achievement that has no rule in `pixeljs.json`. */
  unlock(id: string): Promise<UnlockResult>;
  /**
   * Saves a string in a slot. Pass the `rev` you loaded so a newer save from another
   * device is never overwritten. Outside the portal, saves last until the page closes.
   */
  save(slot: string, data: string, options?: { rev?: number }): Promise<SaveResult>;
  /** Loads a slot. */
  load(slot: string): Promise<LoadResult>;
  /** Whether the player is signed in, and their public handle. */
  player(): Promise<PlayerInfo>;
  readonly multiplayer: Multiplayer;
}
