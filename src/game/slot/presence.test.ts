import { describe, expect, it } from "vitest";
import type { PlayerId } from "@/kernel";
import type { RejoinStrategy } from "../model";
import { makeSetup, makeSlot, observation, parseEnv, pid, slotEnv } from "../test-kit";
import {
  applyQuorum,
  awayOf,
  computePresence,
  isPaused,
  presence,
  presenceOf,
  resume,
  type PresenceX,
} from "./presence";

const x0: PresenceX = { away: [], since: {}, paused: false, forced: false };
const step = (o: Partial<Parameters<typeof computePresence>[0]> = {}) =>
  computePresence({
    participants: [pid("a"), pid("b")],
    spectators: [] as PlayerId[],
    x: x0,
    present: new Set(["a", "b"]),
    removed: new Set<string>(),
    now: 0,
    awayAfterMs: 10_000,
    rejoin: () => "restore" as RejoinStrategy,
    ...o,
  });

describe("computePresence", () => {
  it("everyone present: nothing changes, same references", () => {
    const out = step();
    expect(out.changes).toEqual([]);
    expect(out.x).toBe(x0);
  });

  it("first sight of a missing participant only stamps `since`", () => {
    const out = step({ present: new Set(["a"]), now: 500 });
    expect(out.changes).toEqual([]);
    expect(out.x.since).toEqual({ b: 500 });
    expect(out.x.away).toEqual([]);
  });

  it("missing for awayAfterMs marks away and clears its stamp", () => {
    const out = step({
      present: new Set(["a"]),
      x: { ...x0, since: { b: 0 } },
      now: 10_000,
    });
    expect(out.changes).toEqual([{ playerId: "b", kind: "away" }]);
    expect(out.x.away).toEqual(["b"]);
    expect(out.x.since).toEqual({});
  });

  it("one tick before the boundary is not yet away", () => {
    const out = step({ present: new Set(["a"]), x: { ...x0, since: { b: 0 } }, now: 9_999 });
    expect(out.changes).toEqual([]);
  });

  it("an away player that stays missing is not re-stamped; same x", () => {
    const x = { ...x0, away: [pid("b")] };
    const out = step({ present: new Set(["a"]), x });
    expect(out.changes).toEqual([]);
    expect(out.x).toBe(x);
  });

  it("a returning away player is restored by default", () => {
    const out = step({ x: { ...x0, away: [pid("b")] } });
    expect(out.changes).toEqual([{ playerId: "b", kind: "returned" }]);
    expect(out.x.away).toEqual([]);
    expect(out.participants).toEqual(["a", "b"]);
  });

  it("rejoin `spectate` demotes the returning player", () => {
    const out = step({ x: { ...x0, away: [pid("b")] }, rejoin: () => "spectate" });
    expect(out.changes).toEqual([{ playerId: "b", kind: "dropped" }]);
    expect(out.participants).toEqual(["a"]);
    expect(out.spectators).toEqual(["b"]);
  });

  it("a player removed on purpose is dropped at once, even when present or away", () => {
    const out = step({ removed: new Set(["b"]), x: { ...x0, away: [pid("b")] } });
    expect(out.changes).toEqual([{ playerId: "b", kind: "dropped" }]);
    expect(out.participants).toEqual(["a"]);
    expect(out.spectators).toEqual(["b"]);
    expect(out.x.away).toEqual([]);
  });
});

describe("applyQuorum", () => {
  const two = [pid("a"), pid("b")];
  const belowB = { ...x0, away: [pid("b")] };

  it("no minimum, or `continue`, never changes anything", () => {
    expect(applyQuorum(two, belowB, { belowMin: "pause" })).toEqual({ x: belowB, end: false });
    expect(applyQuorum(two, belowB, { minPresent: 2, belowMin: "continue" })).toEqual({
      x: belowB,
      end: false,
    });
  });

  it("`end` reports the end only while below the minimum", () => {
    expect(applyQuorum(two, belowB, { minPresent: 2, belowMin: "end" }).end).toBe(true);
    expect(applyQuorum(two, x0, { minPresent: 2, belowMin: "end" }).end).toBe(false);
  });

  it("`pause` pauses below the minimum and resumes above it", () => {
    const paused = applyQuorum(two, belowB, { minPresent: 2, belowMin: "pause" });
    expect(paused.x).toEqual({ ...belowB, paused: true, forced: false });
    const back = applyQuorum(two, { ...x0, paused: true }, { minPresent: 2, belowMin: "pause" });
    expect(back.x).toEqual({ ...x0, paused: false, forced: false });
  });

  it("forced keeps the game running below the minimum, and resets above it", () => {
    const forced = { ...belowB, forced: true };
    const same = applyQuorum(two, forced, { minPresent: 2, belowMin: "pause" });
    expect(same.x).toBe(forced);
    const reset = applyQuorum(two, { ...x0, forced: true }, { minPresent: 2, belowMin: "pause" });
    expect(reset.x.forced).toBe(false);
  });
});

describe("resume", () => {
  it("not paused: nothing; paused: runs on, forced", () => {
    expect(resume(makeSlot())).toBeUndefined();
    const paused = makeSlot({ x: { presence: { ...x0, paused: true } } });
    const out = resume(paused);
    expect(out && presenceOf(out)).toEqual({ ...x0, paused: false, forced: true });
  });
});

describe("presence feature", () => {
  const setup = makeSetup(["a", "b"]);

  it("parse: defaults, valid, malformed", () => {
    expect(presence.parse(undefined, setup, parseEnv())).toEqual(x0);
    const valid = { away: ["a"], since: { b: 5 }, paused: true, forced: false };
    expect(presence.parse(valid, setup, parseEnv())).toEqual(valid);
    expect(presence.parse({ ...valid, paused: "yes" }, setup, parseEnv())).toBeUndefined();
    expect(presence.parse("x", setup, parseEnv())).toBeUndefined();
  });

  it("observe: stamps, marks away, pauses below the minimum, restores on return", () => {
    const observe = presence.observe!;
    const first = observe(
      makeSlot(),
      observation([
        ["a", true],
        ["b", false],
      ]),
      slotEnv({ now: 0 })
    );
    expect(presenceOf(first.slot).since).toEqual({ b: 0 });

    const away = observe(
      first.slot,
      observation([
        ["a", true],
        ["b", false],
      ]),
      slotEnv({ now: 10_000 })
    );
    expect(awayOf(away.slot)).toEqual(["b"]);
    expect(isPaused(away.slot)).toBe(true); // 1 present < minPresent 2

    const back = observe(
      away.slot,
      observation([
        ["a", true],
        ["b", true],
      ]),
      slotEnv({ now: 11_000 })
    );
    expect(awayOf(back.slot)).toEqual([]);
    expect(isPaused(back.slot)).toBe(false);
  });

  it("observe: a removed participant moves to the spectators", () => {
    const out = presence.observe!(
      makeSlot(),
      observation(
        [
          ["a", true],
          ["b", true],
        ],
        ["b"]
      ),
      slotEnv()
    );
    expect(out.slot.setup.participants).toEqual(["a"]);
    expect(out.slot.setup.spectators).toEqual(["b"]);
  });
});
