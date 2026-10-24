// Everything that crosses the network is parsed here, once. Channel values stay opaque JSON: the
// owning channel's schema checks them later. Assumes kernel `s.tagged` adds the discriminant key to
// each variant's output (see "Unverified" in the step 1 handoff).

import { fail, isRecord, ok, s, type Infer, type PeerId, type Result } from "@/kernel";
import type { Wire as TransportWire } from "@/transport";
import {
  BUS_MARKER,
  BUS_WIRE_VERSION,
  MAX_APPLIED_KEYS,
  MAX_COMMAND_ID_CHARS,
  MAX_COMMAND_TYPE_CHARS,
  MAX_COUNTER,
  MAX_OFFER_CHANNELS,
  MAX_REASON_CHARS,
  type WireKind,
} from "./names";

export interface WireLimits {
  /** Largest serialized channel value (JSON characters). Use BusConfig.maxStateChars. */
  maxValueChars: number;
}

export interface WireIssue {
  path: string;
  expected: string;
}

function buildSchema(limits: WireLimits) {
  const counter = (min: number) => s.int({ min, max: MAX_COUNTER });
  const value = s.json({ maxChars: limits.maxValueChars });

  // A full copy of one state channel: version, host time, value, exactly-once marks.
  const copy = {
    ch: s.id("channel"),
    epoch: counter(0),
    rev: counter(0),
    asOf: s.number(),
    value,
    applied: s.record(counter(1), { maxKeys: MAX_APPLIED_KEYS, onInvalid: "drop" }),
  };
  // One private piece of one player, matched to the state by (round, rev).
  const piece = { ch: s.id("channel"), round: counter(0), rev: counter(0), value };

  return s.tagged("kind", {
    state: s.object(copy),
    offer: s.object({
      channels: s.list(s.object(copy), { max: MAX_OFFER_CHANNELS, onInvalid: "drop" }),
    }),
    sync: s.object({ ch: s.id("channel") }),
    command: s.object({
      ch: s.id("channel"),
      id: s.string({ max: MAX_COMMAND_ID_CHARS }),
      seq: counter(1),
      type: s.string({ max: MAX_COMMAND_TYPE_CHARS }),
      payload: value,
    }),
    ack: s.object({
      id: s.string({ max: MAX_COMMAND_ID_CHARS }),
      ok: s.boolean(),
      reason: s.optional(s.string({ max: MAX_REASON_CHARS })),
    }),
    event: s.object({ ch: s.id("channel"), event: value }),
    recover: s.object({}),
    private: s.object(piece),
    mine: s.object(piece),
  } satisfies Record<WireKind, unknown>);
}

export type BusMsg = Infer<ReturnType<typeof buildSchema>>;
export type BusMsgOf<K extends WireKind> = Extract<BusMsg, { kind: K }>;
export type ChannelCopy = BusMsgOf<"offer">["channels"][number];

/** A new wire kind does not compile without a handler. `from` is the host-verified sender. */
export type WireHandlers = { [K in WireKind]: (from: PeerId, msg: BusMsgOf<K>) => void };

export interface BusWire {
  parse(input: unknown): Result<BusMsg, WireIssue>;
  encode(msg: BusMsg): TransportWire;
}

export function createBusWire(limits: WireLimits): BusWire {
  const schema = buildSchema(limits);
  return {
    parse(input) {
      if (!isRecord(input) || input[BUS_MARKER] !== BUS_WIRE_VERSION) {
        return fail({ path: BUS_MARKER, expected: "bus message" });
      }
      const checked = schema.check(input);
      if (checked.ok) return ok(checked.value);
      const { path, expected } = checked.reason;
      return fail({ path: String(path), expected: String(expected) });
    },
    encode(msg) {
      return { [BUS_MARKER]: BUS_WIRE_VERSION, ...msg } as TransportWire;
    },
  };
}

/** For the throttled `{from, kind}` warning: the claimed kind of input that failed to parse. */
export function claimedKind(input: unknown): string {
  return isRecord(input) && typeof input.kind === "string" ? input.kind.slice(0, 32) : "?";
}

/** Ack wire fields (ok, reason) to the verdict the sender's queue resolves with. */
export function ackVerdict(msg: BusMsgOf<"ack">): Result<void, string> {
  return msg.ok ? ok() : fail(msg.reason ?? "rejected");
}
