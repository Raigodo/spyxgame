// The remembered nickname. `store` is already prefixed (createRoster wraps Storages.profile with
// PROFILE_KEY_PREFIX in `openProfile`). The store is best-effort: it never throws.

import { prefixed, type KeyValueStore } from "@/kernel";
import { PROFILE_KEY_PREFIX } from "./names";

const NAME_KEY = "name";

export interface ProfileStore {
  loadName(): string | undefined;
  saveName(name: string): void;
}

export function createProfileStore(store: KeyValueStore, ttlMs: number): ProfileStore {
  return {
    loadName: () => store.get(NAME_KEY),
    saveName: (name) => store.set(NAME_KEY, name, { ttlMs }),
  };
}

/** The remembered nickname in the browser's profile storage. The landing page and the roster share it. */
export function openProfile(profile: KeyValueStore, ttlMs: number): ProfileStore {
  return createProfileStore(prefixed(profile, PROFILE_KEY_PREFIX), ttlMs);
}

/** The nickname a new join uses: explicit, else remembered, else the default. Pure. */
export function pickName(
  explicit: string | undefined,
  remembered: string | undefined,
  fallback: string,
  maxLength: number
): string {
  const chosen = [explicit, remembered].map((n) => n?.trim()).find((n) => n);
  return (chosen ?? fallback).slice(0, maxLength);
}
