/** Firestore collection and document names. Nothing else in the repo holds these literals. */
export const PATHS = {
  rooms: "rooms",
  peers: "signaling-peers",
  messages: "messages",
  candidates: "election-candidates",
  host: "host",
  hostDoc: "current",
} as const;
