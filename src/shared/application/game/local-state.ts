import type { KeyValueStore } from "@/shared/kernel";

/** Longer serialized values are not stored. */
export const MAX_LOCAL_LENGTH = 50_000;

/** Shape of the optional `local` dependency of ClientGameBackend. */
export interface LocalStorageDeps {
  store: KeyValueStore;
  ttlSeconds: number;
  getRoomId(): string | undefined;
}

/** Device-only state for one player in one game round. Never sent to anyone. */
export interface LocalStateDef<L> {
  /** Unique within the game: letters, digits, `_` and `-`. */
  id: string;
  initial(): L;
  /** Stored data is untrusted: return a sanitized value, or undefined to fall back to initial(). */
  validate(raw: unknown): L | undefined;
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;

export function defineLocalState<L>(def: LocalStateDef<L>): LocalStateDef<L> {
  if (!ID.test(def.id)) throw new Error(`[local-state] Bad id "${def.id}".`);
  return def;
}
