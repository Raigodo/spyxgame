import { describe, expect, it } from "vitest";
import { DEFAULT_GAME_CONFIG } from "../config";
import { makeSlot, parseEnv, slotEnv } from "../test-kit";
import {
  consumeTimer,
  dueTimers,
  isDue,
  nextDeadline,
  parseTimers,
  syncTimerPause,
  syncTimers,
  timers,
  timersOf,
  withoutTimer,
} from "./timers";

const entry = (deadlineAt: number, frozenMs?: number) => ({
  timer: "ding",
  payload: undefined,
  deadlineAt,
  ...(frozenMs !== undefined && { frozenMs }),
});
const slotWith = (x: Record<string, ReturnType<typeof entry>>, paused = false) =>
  makeSlot({
    x: {
      timers: x,
      ...(paused && { presence: { away: [], since: {}, paused: true, forced: false } }),
    },
  });

describe("parseTimers", () => {
  const env = parseEnv();

  it("keeps valid timers and drops invalid ones", () => {
    const out = parseTimers(
      {
        ok: { timer: "ding", deadlineAt: 5 },
        frozen: { timer: "ding", deadlineAt: 0, frozenMs: 250 },
        unknown: { timer: "nope", deadlineAt: 5 },
        nan: { timer: "ding", deadlineAt: Number.NaN },
        negative: { timer: "ding", deadlineAt: 5, frozenMs: -1 },
        huge: { timer: "ding", deadlineAt: 5, frozenMs: DEFAULT_GAME_CONFIG.maxTimerMs + 1 },
        junk: "x",
        "": { timer: "ding", deadlineAt: 5 },
        ["x".repeat(65)]: { timer: "ding", deadlineAt: 5 },
      },
      env
    );
    expect(Object.keys(out ?? {})).toEqual(["ok", "frozen"]);
    expect(out?.frozen?.frozenMs).toBe(250);
  });

  it("rejects non-records and too many timers", () => {
    expect(parseTimers("x", env)).toBeUndefined();
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`t${i}`, { timer: "ding", deadlineAt: 1 }])
    );
    expect(parseTimers(many, env)).toBeUndefined();
  });

  it("the feature parses a missing key to no timers", () => {
    expect(timers.parse(undefined, makeSlot().setup, env)).toEqual({});
  });
});

describe("pause sync", () => {
  it("freezes running timers while paused, restarts them on resume", () => {
    const running = { t1: entry(5_000) };
    const frozen = syncTimerPause(running, true, 1_000);
    expect(frozen.t1?.frozenMs).toBe(4_000);
    expect(syncTimerPause(frozen, true, 2_000)).toBe(frozen);
    const resumed = syncTimerPause(frozen, false, 2_000);
    expect(resumed.t1).toEqual({ timer: "ding", payload: undefined, deadlineAt: 6_000 });
    expect("frozenMs" in (resumed.t1 ?? {})).toBe(false);
    expect(syncTimerPause(running, false, 0)).toBe(running);
  });

  it("syncTimers: same slot when unchanged, freezes when the slot is paused", () => {
    const running = slotWith({ t1: entry(5_000) });
    expect(syncTimers(running, 1_000)).toBe(running);
    const paused = slotWith({ t1: entry(5_000) }, true);
    expect(timersOf(syncTimers(paused, 1_000)).t1?.frozenMs).toBe(4_000);
  });
});

describe("due timers", () => {
  const slot = slotWith({ due: entry(100), later: entry(900), frozen: entry(0, 50) });

  it("isDue: deadline reached, not frozen, game not paused", () => {
    expect(isDue(slot, "due", 100)).toBe(true);
    expect(isDue(slot, "later", 100)).toBe(false);
    expect(isDue(slot, "frozen", 5_000)).toBe(false);
    expect(isDue(slot, "missing", 5_000)).toBe(false);
    expect(isDue(slotWith({ due: entry(100) }, true), "due", 5_000)).toBe(false);
  });

  it("dueTimers and nextDeadline", () => {
    expect(dueTimers(slot, 500)).toEqual(["due"]);
    expect(nextDeadline(slot)).toBe(100);
    expect(nextDeadline(slotWith({ f: entry(0, 50) }))).toBeUndefined();
    expect(nextDeadline(makeSlot())).toBeUndefined();
  });

  it("consumeTimer removes one timer; withoutTimer does not mutate", () => {
    expect(Object.keys(timersOf(consumeTimer(slot, "due")))).toEqual(["later", "frozen"]);
    const x = { a: entry(1), b: entry(2) };
    expect(Object.keys(withoutTimer(x, "a"))).toEqual(["b"]);
    expect(Object.keys(x)).toEqual(["a", "b"]);
  });
});

describe("startTimer / cancelTimer effects", () => {
  const apply = timers.effect!.apply;
  const start = (o: Record<string, unknown> = {}) => ({
    type: "startTimer",
    id: "t1",
    timer: "ding",
    afterMs: 500,
    ...o,
  });
  const env = slotEnv({ now: 1_000 });

  it("stamps the deadline from host time and replaces a timer with the same id", () => {
    const first = apply({}, start(), env, makeSlot());
    expect(first).toEqual({ ok: true, value: { t1: entry(1_500) } });
    const again = apply(first.ok ? first.value : {}, start({ afterMs: 100 }), env, makeSlot());
    expect(again.ok && again.value.t1?.deadlineAt).toBe(1_100);
  });

  it("a timer started while paused starts frozen", () => {
    const out = apply({}, start(), env, slotWith({}, true));
    expect(out.ok && out.value.t1?.frozenMs).toBe(500);
  });

  it("rejects bad ids, durations, unknown timers and too many timers", () => {
    const bad = [
      start({ afterMs: -1 }),
      start({ afterMs: DEFAULT_GAME_CONFIG.maxTimerMs + 1 }),
      start({ afterMs: Number.NaN }),
      start({ timer: "nope" }),
      start({ timer: 5 }),
      start({ id: "" }),
      start({ id: "x".repeat(65) }),
    ];
    for (const effect of bad) {
      expect(apply({}, effect, env, makeSlot())).toEqual({ ok: false, reason: "invalid-effect" });
    }
    const tight = slotEnv({ config: { ...DEFAULT_GAME_CONFIG, maxTimers: 1 } });
    expect(apply({ other: entry(1) }, start(), tight, makeSlot())).toEqual({
      ok: false,
      reason: "invalid-effect",
    });
  });

  it("cancel removes a timer; a non-string id is invalid", () => {
    const out = apply({ t1: entry(1) }, { type: "cancelTimer", id: "t1" }, env, makeSlot());
    expect(out).toEqual({ ok: true, value: {} });
    expect(apply({}, { type: "cancelTimer", id: 5 }, env, makeSlot()).ok).toBe(false);
  });
});
