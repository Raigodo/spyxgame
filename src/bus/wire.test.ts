import { describe, expect, it } from "vitest";
import { as, type ChannelId } from "@/kernel";
import { BUS_MARKER, BUS_WIRE_VERSION, MAX_OFFER_CHANNELS } from "./names";
import { ackVerdict, claimedKind, createBusWire, type BusMsg } from "./wire";

const wire = createBusWire({ maxValueChars: 50 });
const ch = as<ChannelId>("c");
const copy = { ch, epoch: 1, rev: 2, asOf: 5, value: { a: 1 }, applied: { p: 3 } };

const messages: BusMsg[] = [
  { kind: "state", ...copy },
  { kind: "offer", channels: [copy] },
  { kind: "sync", ch },
  { kind: "command", ch, id: "i1", seq: 1, type: "inc", payload: { by: 1 } },
  { kind: "ack", id: "i1", ok: true },
  { kind: "ack", id: "i1", ok: false, reason: "nope" },
  { kind: "event", ch, event: { text: "hi" } },
  { kind: "recover" },
  { kind: "private", ch, round: 1, rev: 2, value: "s" },
  { kind: "mine", ch, round: 1, rev: 2, value: null },
];

describe("encode / parse", () => {
  it("encode stamps the marker and version", () => {
    const encoded = wire.encode({ kind: "recover" }) as Record<string, unknown>;
    expect(encoded[BUS_MARKER]).toBe(BUS_WIRE_VERSION);
    expect(encoded.kind).toBe("recover");
  });

  it.each(messages.map((m) => [m.kind, m] as const))("round-trips %s", (_kind, msg) => {
    expect(wire.parse(wire.encode(msg))).toEqual({ ok: true, value: msg });
  });
});

describe("parse rejects", () => {
  const good = () => wire.encode({ kind: "sync", ch }) as Record<string, unknown>;

  it("non-objects, a missing marker and another version", () => {
    expect(wire.parse("x").ok).toBe(false);
    expect(wire.parse(null).ok).toBe(false);
    const noMarker = { ...good() };
    delete noMarker[BUS_MARKER];
    const r = wire.parse(noMarker);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.path).toBe(BUS_MARKER);
    expect(wire.parse({ ...good(), [BUS_MARKER]: 2 }).ok).toBe(false);
  });

  it("an unknown kind or a bad field, reporting the path", () => {
    expect(wire.parse({ ...good(), kind: "zzz" }).ok).toBe(false);
    const r = wire.parse({ ...good(), ch: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.path).toBe("ch");
  });

  it("out-of-range counters", () => {
    const base = wire.encode({ kind: "state", ...copy }) as Record<string, unknown>;
    expect(wire.parse({ ...base, epoch: -1 }).ok).toBe(false);
    const cmd = wire.encode(messages[3] as BusMsg) as Record<string, unknown>;
    expect(wire.parse({ ...cmd, seq: 0 }).ok).toBe(false);
  });

  it("a value over the size cap", () => {
    const base = wire.encode({ kind: "state", ...copy }) as Record<string, unknown>;
    expect(wire.parse({ ...base, value: "x".repeat(60) }).ok).toBe(false);
  });
});

describe("parse sanitises", () => {
  it("drops invalid `applied` entries", () => {
    const base = wire.encode({ kind: "state", ...copy }) as Record<string, unknown>;
    const r = wire.parse({ ...base, applied: { a: 1, b: 0 } });
    expect(r.ok && r.value.kind === "state" && r.value.applied).toEqual({ a: 1 });
  });

  it("drops invalid channels of an offer, rejects too many", () => {
    const base = wire.encode({ kind: "offer", channels: [copy] }) as Record<string, unknown>;
    const mixed = wire.parse({ ...base, channels: [copy, { bad: 1 }] });
    expect(mixed.ok && mixed.value.kind === "offer" && mixed.value.channels).toHaveLength(1);
    const many = Array.from({ length: MAX_OFFER_CHANNELS + 1 }, () => copy);
    expect(wire.parse({ ...base, channels: many }).ok).toBe(false);
  });

  it("strips unknown keys", () => {
    const base = wire.encode({ kind: "sync", ch }) as Record<string, unknown>;
    const r = wire.parse({ ...base, extra: 1 });
    expect(r).toEqual({ ok: true, value: { kind: "sync", ch } });
  });
});

describe("helpers", () => {
  it("claimedKind", () => {
    expect(claimedKind({ kind: "state" })).toBe("state");
    expect(claimedKind("x")).toBe("?");
    expect(claimedKind({ kind: 5 })).toBe("?");
    expect(claimedKind({ kind: "k".repeat(100) })).toHaveLength(32);
  });
  it("ackVerdict", () => {
    expect(ackVerdict({ kind: "ack", id: "i", ok: true })).toEqual({ ok: true, value: undefined });
    expect(ackVerdict({ kind: "ack", id: "i", ok: false, reason: "r" })).toEqual({
      ok: false,
      reason: "r",
    });
    expect(ackVerdict({ kind: "ack", id: "i", ok: false })).toEqual({
      ok: false,
      reason: "rejected",
    });
  });
});
