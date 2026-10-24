// Device-only state of a game (notes, UI memory that must survive a refresh): kept in
// `Storages.device` under `game-local:<roomId>:<gameId>:<round>:<playerId>:<id>` with a ttl, so it
// is per round and per player and expires by itself. Never `window.localStorage` in a game.

import {
  Cell,
  derived,
  structurallyEqual,
  type KeyValueStore,
  type PlayerId,
  type RoomId,
  type Store,
} from "@/kernel";
import type { GameConfig } from "./config";
import type { LocalStateDef } from "./model";
import { LOCAL_ID_PATTERN, LOCAL_KEY_PREFIX } from "./names";

/** Declares a local value. Throws on a bad id: that is a programmer error, at module load. */
export function defineLocalState<L>(def: LocalStateDef<L>): LocalStateDef<L> {
  if (!LOCAL_ID_PATTERN.test(def.id)) {
    throw new Error(`Local state id "${def.id}" must match ${LOCAL_ID_PATTERN}.`);
  }
  return def;
}

export type LocalStateDeps = {
  storage: KeyValueStore;
  roomId: RoomId;
  gameId: string;
  playerId: PlayerId;
  /** The round of this game while it is the active one; undefined otherwise. */
  round: Store<number | undefined>;
  config: Pick<GameConfig, "localTtlMs" | "maxLocalChars">;
};

/** One local value. The same object for the same def id is the caller's job (GameHandle memoizes). */
export function createLocalState<L>(
  deps: LocalStateDeps,
  def: LocalStateDef<L>
): { value: Store<L>; set(next: L): void } {
  defineLocalState(def);
  const { storage, roomId, gameId, playerId, round, config } = deps;
  const keyFor = (r: number): string =>
    `${LOCAL_KEY_PREFIX}${roomId}:${gameId}:${r}:${playerId}:${def.id}`;
  const tick = new Cell(0); // a write bumps it, so `value` re-reads

  const read = (r: number | undefined): L => {
    if (r === undefined) return def.initial();
    const raw = storage.get(keyFor(r));
    if (raw === undefined) return def.initial();
    try {
      return def.schema.parse(JSON.parse(raw)) ?? def.initial();
    } catch {
      return def.initial();
    }
  };

  const value = derived([round, tick] as const, (r) => read(r), structurallyEqual);

  return {
    value,
    /** No-op while the game is not active. An oversized value is dropped. */
    set(next) {
      const r = round.get();
      if (r === undefined) return;
      const raw = JSON.stringify(next);
      if (raw === undefined || raw.length > config.maxLocalChars) return;
      storage.set(keyFor(r), raw, { ttlMs: config.localTtlMs });
      tick.update((n) => n + 1);
    },
  };
}
