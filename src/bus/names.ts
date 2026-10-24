// Wire literals and wire limits for the bus. Nothing else in the bus holds a string literal for the wire.

export const BUS_MARKER = "__bus" as const;
export const BUS_WIRE_VERSION = 1 as const;

export const WIRE_KINDS = [
  "state",
  "offer",
  "sync",
  "command",
  "ack",
  "event",
  "recover",
  "private",
  "mine",
] as const;

export type WireKind = (typeof WIRE_KINDS)[number];

// Structural caps for the envelope. Payload size is capped by BusConfig.maxStateChars.
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER; // epoch, rev, seq, round
export const MAX_COMMAND_ID_CHARS = 64;
export const MAX_COMMAND_TYPE_CHARS = 64;
export const MAX_REASON_CHARS = 64;
export const MAX_APPLIED_KEYS = 512; // peers never reuse ids and `applied` is pruned, so this is generous
export const MAX_OFFER_CHANNELS = 32;
