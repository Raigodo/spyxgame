// Game tuning. Plain values, like bus/config.ts (plan open point 9: no descriptor set yet).
// Values marked "legacy" are the old constants; the rest are new caps that the rewrite needs
// because every replicated collection must be bounded (zoom-5, guarantee 7).

export interface GameConfig {
  /** A participant not `here` this long is marked away (host time). A game may override it. Legacy 10 s. */
  awayAfterMs: number;
  /** A host wake-up is never armed sooner than this, so a command that keeps failing cannot spin. */
  minWakeMs: number;
  /** Watcher runs caused by its own commits before it logs a warning and stops until an input changes. */
  maxSettlePasses: number;
  /** Largest serialized `settings` (JSON characters), also what `last.settings` may carry. */
  maxSettingsChars: number;
  /** Cap for every per-player collection in a slot (participants, spectators, names, teams, private revisions). Legacy 200. */
  maxSlotPlayers: number;
  /** Player names in a slot are cut to this. Legacy 64. */
  maxNameChars: number;
  /** Longest game id and team id on the wire. Legacy 64. */
  maxIdChars: number;
  /** Largest serialized private piece or ephemeral game event (JSON characters). */
  maxPieceChars: number;
  /** Newest notices kept in a slot. Legacy 50. */
  maxNotices: number;
  /** Running timers per slot. Legacy 20. */
  maxTimers: number;
  /** Longest `startTimer.afterMs`. Legacy 24 h. */
  maxTimerMs: number;
  /** Longest timer id. Legacy 64. */
  maxTimerIdChars: number;
  /** Device-only game state expires this long after it was last written. Legacy 24 h (was seconds). */
  localTtlMs: number;
  /** A local-state value longer than this (serialized) is not stored. Legacy 50 000. */
  maxLocalChars: number;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  awayAfterMs: 10_000,
  minWakeMs: 50,
  maxSettlePasses: 8,
  maxSettingsChars: 10_000,
  maxSlotPlayers: 200,
  maxNameChars: 64,
  maxIdChars: 64,
  maxPieceChars: 10_000,
  maxNotices: 50,
  maxTimers: 20,
  maxTimerMs: 24 * 60 * 60 * 1000,
  maxTimerIdChars: 64,
  localTtlMs: 24 * 60 * 60 * 1000,
  maxLocalChars: 50_000,
};
