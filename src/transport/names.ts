/** Wire literals and storage keys owned by transport. Firestore paths live in signaling/names.ts. */
export const FRAME = {
  chunk: "__chunk",
  probe: "__probe",
  hello: "hello",
  bye: "bye",
  app: "app",
} as const;

/** Prefix for the per-tab host-claim hint, applied with `prefixed(storages.tab, ...)`. */
export const CLAIM_KEY_PREFIX = "host-claim:";
