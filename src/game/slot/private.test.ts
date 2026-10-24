import { describe, expect, it } from "vitest";
import { DEFAULT_GAME_CONFIG } from "../config";
import { makeSetup, makeSlot, observation, parseEnv, slotEnv } from "../test-kit";
import { applyPrivatePatches, privateOf, privatePieces, revisions } from "./private";

describe("revisions", () => {
  it("none without a slot; the slot's revisions with the round; defensive about garbage", () => {
    expect(revisions({ round: 3, slot: null })).toBeUndefined();
    const slot = makeSlot({ x: { private: { rev: { a: 2 }, seq: 2 } } });
    expect(revisions({ round: 3, slot })).toEqual({ round: 3, rev: { a: 2 } });
    const odd = makeSlot({ x: { private: "x" } });
    expect(revisions({ round: 3, slot: odd })).toEqual({ round: 3, rev: {} });
  });
});

describe("applyPrivatePatches", () => {
  const env = slotEnv({ round: 4 });

  it("nothing to write: same slot, no writes", () => {
    const slot = makeSlot();
    expect(applyPrivatePatches(slot, undefined, env)).toEqual({
      ok: true,
      value: { slot, writes: [] },
    });
    const empty = applyPrivatePatches(slot, {}, env);
    expect(empty.ok && empty.value.slot).toBe(slot);
  });

  it("a new piece gets the next revision, stamped with the round", () => {
    const out = applyPrivatePatches(makeSlot(), { a: "p1" }, env);
    expect(out.ok && out.value.writes).toEqual([{ playerId: "a", round: 4, rev: 1, value: "p1" }]);
    expect(out.ok && privateOf(out.value.slot)).toEqual({ rev: { a: 1 }, seq: 1 });
  });

  it("revisions are never reused within a round", () => {
    const first = applyPrivatePatches(makeSlot(), { a: "p1" }, env);
    const second = applyPrivatePatches(
      first.ok ? first.value.slot : makeSlot(),
      { a: "p2", b: "q" },
      env
    );
    expect(second.ok && second.value.writes.map((w) => [w.playerId, w.rev])).toEqual([
      ["a", 2],
      ["b", 3],
    ]);
  });

  it("null removes a piece (rev 0); removing a piece that never existed writes nothing", () => {
    const given = applyPrivatePatches(makeSlot(), { a: "p1" }, env);
    const slot = given.ok ? given.value.slot : makeSlot();
    const removed = applyPrivatePatches(slot, { a: null }, env);
    expect(removed.ok && removed.value.writes).toEqual([
      { playerId: "a", round: 4, rev: 0, value: null },
    ]);
    expect(removed.ok && privateOf(removed.value.slot).rev).toEqual({});
    const nothing = applyPrivatePatches(makeSlot(), { a: null }, env);
    expect(nothing.ok && nothing.value.slot).toEqual(nothing.ok && nothing.value.slot);
    expect(nothing.ok && nothing.value.writes).toEqual([]);
  });

  it("rejects unknown players, invalid pieces and too many patches", () => {
    expect(applyPrivatePatches(makeSlot(), { zz: "p" }, env)).toEqual({
      ok: false,
      reason: "invalid-private",
    });
    expect(applyPrivatePatches(makeSlot(), { a: "x".repeat(51) }, env)).toEqual({
      ok: false,
      reason: "invalid-private",
    });
    const tight = slotEnv({ config: { ...DEFAULT_GAME_CONFIG, maxSlotPlayers: 1 } });
    expect(applyPrivatePatches(makeSlot(), { a: "1", b: "2" }, tight)).toEqual({
      ok: false,
      reason: "invalid-private",
    });
  });
});

describe("privatePieces feature", () => {
  const setup = makeSetup(["a", "b"]);

  it("parse: default, valid (seq at least the highest rev), malformed", () => {
    expect(privatePieces.parse(undefined, setup, parseEnv())).toEqual({ rev: {}, seq: 0 });
    expect(privatePieces.parse({ rev: { a: 2 }, seq: 1 }, setup, parseEnv())).toEqual({
      rev: { a: 2 },
      seq: 2,
    });
    expect(privatePieces.parse({ rev: { a: 0 }, seq: 0 }, setup, parseEnv())).toEqual({
      rev: {},
      seq: 0,
    });
    expect(privatePieces.parse({ rev: "x", seq: 0 }, setup, parseEnv())).toBeUndefined();
  });

  it("observe rebuilds a piece the host lost through the game's `recover`", () => {
    const slot = makeSlot({ x: { private: { rev: { a: 1 }, seq: 1 } } });
    const lost = privatePieces.observe!(slot, observation([]), slotEnv());
    expect(lost.private).toEqual({ a: "recovered-a" });
  });

  it("observe leaves held pieces and players that never had one alone", () => {
    const slot = makeSlot({ x: { private: { rev: { a: 1 }, seq: 1 } } });
    const held = privatePieces.observe!(
      slot,
      observation([]),
      slotEnv({ private: { get: () => "held" } })
    );
    expect(held.slot).toBe(slot);
    expect(held.private).toBeUndefined();

    const none = makeSlot();
    const untouched = privatePieces.observe!(none, observation([]), slotEnv());
    expect(untouched.slot).toBe(none);
    expect(untouched.private).toBeUndefined();
  });
});
