import { describe, expect, it } from "vitest";
import { makeSetup, makeSlot, observation, parseEnv, slotEnv } from "../test-kit";
import { applyEffects, applyReduction, createSlot, initialX, observeAll, parseX } from "./index";
import { awayOf, isPaused } from "./presence";
import { privateOf } from "./private";
import { noticesOf } from "./notices";
import { timersOf } from "./timers";

const setup = makeSetup(["a", "b"]);
const said = { type: "emit", event: { type: "said", text: "hi" } };
const startTimer = { type: "startTimer", id: "t1", timer: "ding", afterMs: 100 };

describe("initialX / parseX", () => {
  it("every feature has an initial value under its key", () => {
    expect(Object.keys(initialX(setup)).sort()).toEqual([
      "notices",
      "presence",
      "private",
      "timers",
    ]);
  });
  it("a missing x defaults; a non-record or a malformed feature rejects", () => {
    expect(parseX(undefined, setup, parseEnv())).toEqual(initialX(setup));
    expect(parseX("x", setup, parseEnv())).toBeUndefined();
    expect(parseX({ presence: { away: "x" } }, setup, parseEnv())).toBeUndefined();
  });
  it("round-trips its own output", () => {
    const x = initialX(setup);
    expect(parseX(x, setup, parseEnv())).toEqual(x);
  });
});

describe("applyEffects", () => {
  it("routes each effect to the feature that owns it; `end` is the framework's", () => {
    const out = applyEffects(makeSlot(), [said, startTimer, { type: "end" }], slotEnv());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.end).toBe(true);
    expect(noticesOf(out.value.slot).list).toHaveLength(1);
    expect(Object.keys(timersOf(out.value.slot))).toEqual(["t1"]);
  });
  it("no effects: same slot", () => {
    const slot = makeSlot();
    const out = applyEffects(slot, undefined, slotEnv());
    expect(out.ok && out.value).toEqual({ slot, end: false });
  });
  it("an unknown effect type or one invalid effect fails the whole batch", () => {
    expect(applyEffects(makeSlot(), [{ type: "zzz" }], slotEnv())).toEqual({
      ok: false,
      reason: "invalid-effect",
    });
    expect(applyEffects(makeSlot(), [said, { ...startTimer, afterMs: -1 }], slotEnv())).toEqual({
      ok: false,
      reason: "invalid-effect",
    });
  });
});

describe("applyReduction", () => {
  it("applies state, effects and private patches together", () => {
    const out = applyReduction(
      makeSlot(),
      { state: { n: 5 }, effects: [said], private: { a: "s" } },
      slotEnv()
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.slot.state).toEqual({ n: 5 });
    expect(out.value.writes).toHaveLength(1);
    expect(noticesOf(out.value.slot).seq).toBe(1);
  });
  it("is all or nothing", () => {
    expect(
      applyReduction(makeSlot(), { state: {}, effects: [], private: { zz: "s" } }, slotEnv())
    ).toEqual({ ok: false, reason: "invalid-private" });
    expect(
      applyReduction(makeSlot(), { state: {}, effects: [{ type: "zzz" }] }, slotEnv())
    ).toEqual({ ok: false, reason: "invalid-effect" });
  });
});

describe("observeAll", () => {
  it("nothing to do: the same slot comes back", () => {
    const slot = makeSlot();
    const out = observeAll(
      slot,
      observation([
        ["a", true],
        ["b", true],
      ]),
      slotEnv()
    );
    expect(out).toEqual({ slot, writes: [], end: false });
  });

  it("features run in order: an away player pauses the game and that freezes timers", () => {
    const slot = makeSlot({
      x: {
        presence: { away: [], since: { b: 0 }, paused: false, forced: false },
        timers: { t1: { timer: "ding", payload: undefined, deadlineAt: 50_000 } },
      },
    });
    const out = observeAll(
      slot,
      observation([
        ["a", true],
        ["b", false],
      ]),
      slotEnv({ now: 10_000 })
    );
    expect(awayOf(out.slot)).toEqual(["b"]);
    expect(isPaused(out.slot)).toBe(true);
    expect(timersOf(out.slot).t1?.frozenMs).toBe(40_000);
  });
});

describe("createSlot", () => {
  const runtime = { id: "probe", version: 1 };
  it("builds a slot with every feature's initial value and the first private pieces", () => {
    const out = createSlot(
      {
        runtime,
        plan: { settings: { rounds: 1 }, state: { n: 0 }, private: { a: "piece" } },
        setup,
        seed: 9,
      },
      slotEnv({ round: 2 })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.slot).toMatchObject({ gameId: "probe", version: 1, seed: 9, state: { n: 0 } });
    expect(out.value.writes).toEqual([{ playerId: "a", round: 2, rev: 1, value: "piece" }]);
    expect(privateOf(out.value.slot).rev).toEqual({ a: 1 });
  });
  it("an invalid first piece fails the start", () => {
    const out = createSlot(
      { runtime, plan: { settings: {}, state: {}, private: { zz: "piece" } }, setup, seed: 9 },
      slotEnv()
    );
    expect(out).toEqual({ ok: false, reason: "invalid-private" });
  });
});
