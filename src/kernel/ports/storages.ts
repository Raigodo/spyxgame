import type { KeyValueStore } from "./key-value-store";

/** Three named backends. Slices wrap one with `prefixed(...)` and their own key prefix. */
export interface Storages {
  /** Per tab: survives a refresh of the same tab, gone for a new tab. */
  tab: KeyValueStore;
  /** Per browser profile, long-lived (nickname). */
  profile: KeyValueStore;
  /** Per device, expiring (game-local state). */
  device: KeyValueStore;
}
