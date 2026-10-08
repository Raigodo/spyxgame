import { describe, expect, it } from "vitest";
import { parseWire } from "./wire";

const copy = { ch: "room", epoch: 1, rev: 2, value: { a: 1 }, applied: { p1: 3 } };

describe("parseWire", () => {
  it("parses a state message", () => {
    expect(parseWire({ __bus: 1, kind: "state", ...copy })).toEqual({
      __bus: 1,
      kind: "state",
      ...copy,
    });
  });
  it("rejects anything without the bus marker or with an unknown kind", () => {
    expect(parseWire({ kind: "recover" })).toBeUndefined();
    expect(parseWire({ __bus: 1, kind: "nope" })).toBeUndefined();
    expect(parseWire([])).toBeUndefined();
    expect(parseWire("x")).toBeUndefined();
  });
  it("rejects non-integer epoch/rev and array applied", () => {
    expect(parseWire({ __bus: 1, kind: "state", ...copy, rev: 1.5 })).toBeUndefined();
    expect(parseWire({ __bus: 1, kind: "state", ...copy, applied: [] })).toBeUndefined();
  });
  it("drops non-integer applied marks but keeps the copy", () => {
    const w = parseWire({ __bus: 1, kind: "state", ...copy, applied: { p1: 3, p2: "x" } });
    expect(w).toMatchObject({ applied: { p1: 3 } });
  });
  it("offer keeps valid channels and drops invalid ones", () => {
    const w = parseWire({ __bus: 1, kind: "offer", channels: [copy, { ch: 5 }] });
    expect(w).toMatchObject({ kind: "offer", channels: [{ ch: "room" }] });
    expect((w as { channels: unknown[] }).channels).toHaveLength(1);
  });
  it("command needs string ids and an integer seq", () => {
    const base = { __bus: 1, kind: "command", ch: "c", id: "i", type: "t", payload: null };
    expect(parseWire({ ...base, seq: 1 })).toMatchObject({ kind: "command", seq: 1 });
    expect(parseWire({ ...base, seq: "1" })).toBeUndefined();
    expect(parseWire({ ...base, seq: 1, id: 7 })).toBeUndefined();
  });
  it("ack maps a rejection and defaults its reason", () => {
    expect(parseWire({ __bus: 1, kind: "ack", id: "i", result: { ok: true } })).toMatchObject({
      result: { ok: true },
    });
    expect(
      parseWire({ __bus: 1, kind: "ack", id: "i", result: { ok: false, reason: "no" } })
    ).toMatchObject({ result: { ok: false, kind: "rejected", reason: "no" } });
    expect(parseWire({ __bus: 1, kind: "ack", id: "i", result: 1 })).toBeUndefined();
  });
});
