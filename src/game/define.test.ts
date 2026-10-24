import { describe, expect, it } from "vitest";
import { as, ok, s, type PeerId } from "@/kernel";
import { defineGame } from "./define";
import type { GameSpec } from "./model";
import { makeSetup, makeSlot, otherGame, pid, probeGame, type OtherTypes } from "./test-kit";

const runtime = probeGame.runtime;
const none = { get: () => undefined };
const sender = { playerId: pid("a"), peerId: as<PeerId>("pa") };

const base: GameSpec<OtherTypes> = {
  id: "mig",
  modes: ["free-for-all"],
  settings: s.object({ rounds: s.int({ min: 1, max: 5 }) }),
  state: s.object({ n: s.int({ min: 0, max: 100 }) }),
  init: () => ({ n: 0 }),
  commands: {
    noop: { schema: s.object({ type: s.literal("noop") }), reduce: (a) => ok({ state: a.state }) },
  },
};
const make = (over: Partial<GameSpec<OtherTypes>> = {}) =>
  defineGame<OtherTypes>({ ...base, ...over });

describe("defineGame validation (programmer errors throw at load)", () => {
  it("rejects a bad version, no modes, a bad minPresent and min above max", () => {
    expect(() => make({ version: 0 })).toThrow(/version/);
    expect(() => make({ version: 1.5 })).toThrow(/version/);
    expect(() => make({ modes: [] })).toThrow(/modes/);
    expect(() => make({ presence: { minPresent: 0 } })).toThrow(/minPresent/);
    expect(() => make({ players: { min: 3, max: 2 } })).toThrow(/players/);
  });
  it("exposes id, modes and the runtime", () => {
    expect(probeGame.id).toBe("probe");
    expect(probeGame.modes).toEqual(["free-for-all", "teams"]);
    expect(probeGame.runtime.id).toBe("probe");
  });
});

describe("runtime metadata", () => {
  it("players and presence with and without a spec", () => {
    expect(runtime.players).toEqual({ min: 2, max: 4 });
    expect(runtime.presence).toEqual({ minPresent: 2, belowMin: "pause" });
    expect(otherGame.runtime.players).toEqual({ min: 1, max: Number.POSITIVE_INFINITY });
    expect(otherGame.runtime.presence).toEqual({ belowMin: "continue" });
    expect(runtime.version).toBe(1);
  });
});

describe("migration", () => {
  const game = make({
    version: 2,
    migrate: {
      state: (raw) => ({ n: (raw as { old: number }).old }),
      settings: () => {
        throw new Error("boom");
      },
    },
  });

  it("migrates an older state and leaves a current one alone", () => {
    expect(game.runtime.parseState({ old: 3 }, 1)).toEqual({ ok: true, value: { n: 3 } });
    expect(game.runtime.parseState({ n: 4 }, 2)).toEqual({ ok: true, value: { n: 4 } });
  });
  it("a throwing migration makes the value invalid instead of throwing", () => {
    expect(game.runtime.parseSettings({ rounds: 1 }, 1).ok).toBe(false);
  });
});

describe("runtime parsing", () => {
  it("settings and state", () => {
    expect(runtime.parseSettings({ rounds: 2 }, 1)).toEqual({ ok: true, value: { rounds: 2 } });
    expect(runtime.parseSettings({ rounds: 99 }, 1).ok).toBe(false);
    expect(runtime.parseState({ n: 1 }, 1).ok).toBe(true);
  });
  it("timer payloads: known timers only, inherited names never", () => {
    expect(runtime.parseTimerPayload("ding", undefined)).toEqual({ value: undefined });
    expect(runtime.parseTimerPayload("nope", undefined)).toBeUndefined();
    expect(runtime.parseTimerPayload("constructor", undefined)).toBeUndefined();
  });
  it("events: known types only", () => {
    expect(runtime.parseEvent({ type: "said", text: "hi" })).toEqual({
      value: { type: "said", text: "hi" },
    });
    expect(runtime.parseEvent({ type: "said", text: "x".repeat(21) })).toBeUndefined();
    expect(runtime.parseEvent({ type: "toString" })).toBeUndefined();
    expect(runtime.parseEvent("x")).toBeUndefined();
  });
  it("private pieces: only when the game has a private spec", () => {
    expect(runtime.parsePrivate("x")).toEqual({ value: "x" });
    expect(runtime.parsePrivate(5)).toBeUndefined();
    expect(otherGame.runtime.parsePrivate("x")).toBeUndefined();
  });
  it("commandWho: default participant, own names only", () => {
    expect(runtime.commandWho("inc")).toBe("participant");
    expect(runtime.commandWho("boss")).toBe("host");
    expect(runtime.commandWho("say")).toBe("anyone");
    for (const t of ["zzz", "toString", "constructor"])
      expect(runtime.commandWho(t)).toBeUndefined();
  });
});

describe("runtime.start", () => {
  const input = (participants: string[], extra = {}, settings: unknown = { rounds: 2 }) => ({
    settings,
    setup: makeSetup(participants, extra),
    seed: 5,
  });

  it("builds a plan from validated settings", () => {
    expect(runtime.start(input(["a", "b"]))).toEqual({
      ok: true,
      value: { settings: { rounds: 2 }, state: { n: 0 }, private: {} },
    });
  });
  it("checks mode, player counts and settings", () => {
    expect(otherGame.runtime.start(input(["a"], { mode: "teams" }))).toEqual({
      ok: false,
      reason: "unsupported-mode",
    });
    expect(runtime.start(input(["a"]))).toEqual({ ok: false, reason: "too-few-players" });
    expect(runtime.start(input(["a", "b", "c", "d", "e"]))).toEqual({
      ok: false,
      reason: "too-many-players",
    });
    expect(runtime.start(input(["a", "b"], {}, { rounds: 99 }))).toEqual({
      ok: false,
      reason: "invalid-settings",
    });
  });
});

describe("runtime.play / fire", () => {
  const slot = makeSlot();

  it("runs the reducer and returns state and effects", () => {
    expect(runtime.play(slot, { type: "inc" }, sender, none)).toEqual({
      ok: true,
      value: { state: { n: 1 }, effects: [] },
    });
    const timer = runtime.play(slot, { type: "timer" }, sender, none);
    expect(timer.ok && timer.value.effects).toEqual([
      { type: "startTimer", id: "t1", timer: "ding", afterMs: 1_000 },
    ]);
  });
  it("a reducer rejection passes through", () => {
    const high = makeSlot({ state: { n: 1000 } });
    expect(runtime.play(high, { type: "inc" }, sender, none)).toEqual({
      ok: false,
      reason: "too-high",
    });
  });
  it("unknown commands and invalid payloads", () => {
    expect(runtime.play(slot, { type: "zzz" }, sender, none)).toEqual({
      ok: false,
      reason: "unknown-command",
    });
    expect(runtime.play(slot, { type: "toString" }, sender, none)).toEqual({
      ok: false,
      reason: "unknown-command",
    });
    expect(runtime.play(slot, "x", sender, none)).toEqual({ ok: false, reason: "unknown-command" });
    expect(runtime.play(slot, { type: "say" }, sender, none)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
  it("timers: a handler runs, an unknown timer is undefined", () => {
    expect(runtime.fire(slot, "ding", undefined, none)).toEqual({
      ok: true,
      value: { state: { n: 100 }, effects: [] },
    });
    expect(runtime.fire(slot, "nope", undefined, none)).toBeUndefined();
  });
});

describe("runtime roster hooks", () => {
  const slot = makeSlot();
  it("late: the game's decision, or nothing", () => {
    expect(runtime.late(slot, pid("c"))).toEqual({});
    const teams = makeSlot({ setup: makeSetup(["a", "b"], { mode: "teams", teamIds: ["red"] }) });
    expect(runtime.late(teams, pid("c"))).toEqual({ team: "red" });
    expect(otherGame.runtime.late(slot, pid("c"))).toBeUndefined();
  });
  it("rejoin defaults to restore", () => {
    expect(runtime.rejoin(slot, pid("a"))).toBe("restore");
    const spectate = make({ presence: { rejoin: () => "spectate" } });
    expect(spectate.runtime.rejoin(slot, pid("a"))).toBe("spectate");
  });
  it("changed, initialPrivate and recoverPrivate", () => {
    expect(runtime.changed(slot, [{ playerId: pid("a"), kind: "away" }], none)).toBeUndefined();
    expect(runtime.initialPrivate(slot, pid("a"))).toBeUndefined();
    expect(runtime.recoverPrivate(slot, pid("a"))).toBe("recovered-a");
    const onChange = make({ presence: { onChange: () => ({ state: { n: 9 } }) } });
    expect(onChange.runtime.changed(slot, [], none)).toEqual({ state: { n: 9 }, effects: [] });
  });
});
