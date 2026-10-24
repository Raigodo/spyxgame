import { describe, expect, it } from "vitest";
import { buildView, diffNotices, setupView } from "./view";
import { makeSetup, makeSlot, pid, probeGame, type ProbeTypes } from "./test-kit";

const runtime = probeGame.runtime;
const build = (o: {
  state?: Parameters<typeof buildView>[0]["state"];
  synced?: boolean;
  mine?: unknown;
  playerId?: string;
}) =>
  buildView<ProbeTypes>({
    runtime,
    playerId: pid(o.playerId ?? "a"),
    state: o.state,
    synced: o.synced ?? true,
    mine: o.mine,
  });

describe("setupView", () => {
  it("free-for-all shows only the participants", () => {
    expect(setupView(makeSetup(["a", "b"]))).toEqual({
      mode: "free-for-all",
      participants: ["a", "b"],
    });
  });
  it("teams shows team ids and the assignment", () => {
    const setup = makeSetup(["a"], { mode: "teams", teamIds: ["red"], teams: { a: "red" } });
    expect(setupView(setup)).toEqual({
      mode: "teams",
      teamIds: ["red"],
      teams: { a: "red" },
      participants: ["a"],
    });
  });
});

describe("buildView", () => {
  it("is undefined without state, a slot, a sync, or when another game runs", () => {
    expect(build({ state: undefined })).toBeUndefined();
    expect(build({ state: { round: 1, slot: null } })).toBeUndefined();
    expect(build({ state: { round: 1, slot: makeSlot() }, synced: false })).toBeUndefined();
    expect(
      build({ state: { round: 1, slot: { ...makeSlot(), gameId: "other" } } })
    ).toBeUndefined();
  });

  const full = makeSlot({
    setup: makeSetup(["a", "b"], { spectators: [pid("s")], names: { a: "Ann", b: "Bob" } }),
    state: { n: 3 },
    x: {
      presence: { away: [pid("b")], since: {}, paused: true, forced: false },
      timers: {
        t1: { timer: "ding", payload: undefined, deadlineAt: 500 },
        t2: { timer: "ding", payload: undefined, deadlineAt: 0, frozenMs: 250 },
      },
      notices: { seq: 1, list: [{ seq: 1, event: { type: "said", text: "hi" } }] },
    },
  });

  it("projects the whole slot atomically", () => {
    const view = build({ state: { round: 2, slot: full } });
    expect(view).toMatchObject({
      round: 2,
      settings: { rounds: 1 },
      state: { n: 3 },
      away: ["b"],
      paused: true,
      notices: [{ type: "said", text: "hi" }],
      setup: { mode: "free-for-all", participants: ["a", "b"] },
    });
    expect(view?.players).toEqual([
      { id: "a", name: "Ann", role: "player", away: false },
      { id: "b", name: "Bob", role: "player", away: true },
      { id: "s", name: "s", role: "spectator", away: false },
    ]);
    expect(view?.timers).toEqual([
      { id: "t1", timer: "ding", payload: undefined, deadlineAt: 500, paused: false },
      {
        id: "t2",
        timer: "ding",
        payload: undefined,
        deadlineAt: 0,
        paused: true,
        remainingMs: 250,
      },
    ]);
  });

  it("me: role, team and the private piece (validated by the game's schema)", () => {
    const state = { round: 1, slot: full };
    expect(build({ state, playerId: "s" })?.me).toEqual({ playerId: "s", role: "spectator" });
    expect(build({ state, mine: "secret" })?.me.private).toBe("secret");
    expect(build({ state, mine: 123 })?.me.private).toBeUndefined();
    const teams = makeSlot({
      setup: makeSetup(["a", "b"], { mode: "teams", teamIds: ["red"], teams: { a: "red" } }),
    });
    expect(build({ state: { round: 1, slot: teams } })?.me.team).toBe("red");
  });
});

describe("diffNotices", () => {
  const notice = (seq: number) => ({ seq, event: { type: "said", text: `n${seq}` } });
  const state = (round: number, seq: number, gameId = "probe") => ({
    round,
    slot: {
      ...makeSlot({
        x: { notices: { seq, list: Array.from({ length: seq }, (_, i) => notice(i + 1)) } },
      }),
      gameId,
    },
  });

  it("nothing before the first state", () => {
    expect(diffNotices(undefined, undefined, "probe")).toEqual({ events: [], cursor: undefined });
  });
  it("the first sight of a slot is a quiet baseline", () => {
    expect(diffNotices(undefined, state(2, 2), "probe")).toEqual({
      events: [],
      cursor: { round: 2, seq: 2 },
    });
  });
  it("later notices are reported once", () => {
    const out = diffNotices({ round: 2, seq: 2 }, state(2, 3), "probe");
    expect(out.events).toEqual([notice(3).event]);
    expect(out.cursor).toEqual({ round: 2, seq: 3 });
    expect(diffNotices(out.cursor, state(2, 3), "probe").events).toEqual([]);
  });
  it("no slot of this game puts the cursor at `none`; a slot that starts later is new from seq 0", () => {
    expect(diffNotices({ round: 1, seq: 4 }, { round: 2, slot: null }, "probe").cursor).toBe(
      "none"
    );
    expect(diffNotices({ round: 1, seq: 4 }, state(2, 1, "other"), "probe").cursor).toBe("none");
    const out = diffNotices("none", state(3, 1), "probe");
    expect(out.events).toEqual([notice(1).event]);
  });
  it("a new round starts counting from zero", () => {
    const out = diffNotices({ round: 1, seq: 5 }, state(2, 1), "probe");
    expect(out.events).toEqual([notice(1).event]);
  });
});
