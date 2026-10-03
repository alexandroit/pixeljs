// @pixeljs/core/portal: publishing on the PixelJS portal. This entry is separate from
// the engine's, so games that never use it never load it.
export { BRIDGE_VERSION, connectPortal } from './portal/bridge.js';
export { attachEngine } from './portal/engine.js';
export type { AttachEngineOptions } from './portal/engine.js';
export { createRandom } from './portal/random.js';
export type { Random } from './portal/random.js';
export type {
  GameOverResult,
  Launch,
  LevelEndResult,
  LevelOutcome,
  LevelProgress,
  LevelResult,
  LoadResult,
  MatchEnd,
  MatchMessage,
  MatchStart,
  Multiplayer,
  MultiplayerEvents,
  MultiplayerResult,
  NoData,
  PlayerInfo,
  PlayerLeft,
  PlayMode,
  Portal,
  PortalCapability,
  PortalEvents,
  PortalOptions,
  PortalState,
  Room,
  RoomPlayer,
  RoomResult,
  RoomState,
  SaveResult,
  UnlockResult,
} from './portal/types.js';
