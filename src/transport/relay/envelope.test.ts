import { describe, expect, it } from "vitest";
import { createEnvelopeParser, encodeEnvelope, type Envelope } from "./envelope";
import { as, type PeerId, type PlayerId } from "@/kernel";

const parse = createEnvelopeParser({ maxMessageChars: 200 });
const raw = (o: unknown) => JSON.stringify(o);

describe("createEnvelopeParser", () => {
  it("parses hello and bye", () => {
    expect(parse(raw({ kind: "hello", playerId: "p1" }))).toEqual({
      kind: "hello",
      playerId: "p1",
    });
    expect(parse(raw({ kind: "bye", reason: "kicked" }))).toEqual({
      kind: "bye",
      reason: "kicked",
    });
    expect(parse(raw({ kind: "bye", reason: "superseded" }))).toEqual({
      kind: "bye",
      reason: "superseded",
    });
  });
  it("rejects a bye with an unknown reason or a hello without a playerId", () => {
    expect(parse(raw({ kind: "bye", reason: "other" }))).toBeUndefined();
    expect(parse(raw({ kind: "hello" }))).toBeUndefined();
  });
  it("parses broadcast and direct app envelopes", () => {
    expect(parse(raw({ kind: "app", scope: "broadcast", from: "a", msg: { x: 1 } }))).toEqual({
      kind: "app",
      scope: "broadcast",
      from: "a",
      msg: { x: 1 },
    });
    expect(parse(raw({ kind: "app", scope: "direct", from: "a", to: "b", msg: "hi" }))).toEqual({
      kind: "app",
      scope: "direct",
      from: "a",
      to: "b",
      msg: "hi",
    });
  });
  it("a direct envelope without `to` is invalid; broadcast drops a stray `to`", () => {
    expect(parse(raw({ kind: "app", scope: "direct", from: "a", msg: 1 }))).toBeUndefined();
    expect(parse(raw({ kind: "app", scope: "broadcast", from: "a", to: "b", msg: 1 }))).toEqual({
      kind: "app",
      scope: "broadcast",
      from: "a",
      msg: 1,
    });
  });
  it("rejects bad JSON, unknown kinds, oversize payloads and oversize raw input", () => {
    expect(parse("not json")).toBeUndefined();
    expect(parse(raw({ kind: "zzz" }))).toBeUndefined();
    expect(
      parse(raw({ kind: "app", scope: "broadcast", from: "a", msg: "x".repeat(201) }))
    ).toBeUndefined();
    expect(parse("x".repeat(200 + 1_025))).toBeUndefined();
  });
});

describe("encodeEnvelope", () => {
  it("round-trips through the parser", () => {
    const e: Envelope = {
      kind: "app",
      scope: "direct",
      from: as<PeerId>("a"),
      to: as<PeerId>("b"),
      msg: { n: [1, 2] },
    };
    expect(parse(encodeEnvelope(e))).toEqual(e);
    const hello: Envelope = { kind: "hello", playerId: as<PlayerId>("p") };
    expect(parse(encodeEnvelope(hello))).toEqual(hello);
  });
});
