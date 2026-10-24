import { describe, expect, it } from "vitest";
import { DEFAULT_GAME_CONFIG } from "./config";
import {
  authorize,
  checkStart,
  finish,
  lateJoin,
  newcomers,
  nextWakeAt,
  recordNames,
} from "./rules";
import { makeSetup, makeSlot, observation, pid, probeGame, slotEnv } from "./test-kit";

const runtime = probeGame.runtime;
const member = { fromHost: false, playerId: pid("a") };
const pausedX = { presence: { away: [], since: {}, paused: true, forced: false } };

describe("authorize", () => {
  const slot = makeSlot();

  it("checks in order: no slot, wrong game, unknown game, unknown command", () => {
    expect(authorize(null, runtime, "probe", "inc", member)).toBe("no-active-game");
    expect(authorize(slot, runtime, "other", "inc", member)).toBe("wrong-game");
    expect(authorize(slot, undefined, "probe", "inc", member)).toBe("unknown-game");
    expect(authorize(slot, undefined, "other", "inc", member)).toBe("wrong-game");
    expect(authorize(slot, runtime, "probe", "zzz", member)).toBe("unknown-command");
  });

  it("participant commands need a participant", () => {
    expect(authorize(slot, runtime, "probe", "inc", member)).toBeUndefined();
    expect(authorize(slot, runtime, "probe", "inc", { fromHost: false, playerId: pid("zz") })).toBe(
      "not-a-participant"
    );
    expect(authorize(slot, runtime, "probe", "inc", { fromHost: false })).toBe("not-a-participant");
  });

  it("`anyone` commands need nobody in particular", () => {
    expect(
      authorize(slot, runtime, "probe", "say", { fromHost: false, playerId: pid("zz") })
    ).toBeUndefined();
  });

  it("host commands need the host", () => {
    expect(authorize(slot, runtime, "probe", "boss", member)).toBe("host-only");
    expect(authorize(slot, runtime, "probe", "boss", { fromHost: true })).toBeUndefined();
  });

  it("paused: only host commands run", () => {
    const paused = makeSlot({ x: pausedX });
    expect(authorize(paused, runtime, "probe", "inc", member)).toBe("paused");
    expect(authorize(paused, runtime, "probe", "say", member)).toBe("paused");
    expect(authorize(paused, runtime, "probe", "boss", { fromHost: true })).toBeUndefined();
  });
});

describe("checkStart", () => {
  const idle = { round: 1, slot: null };

  it("rejects a running game, an unknown game, big settings and too many players", () => {
    const cfg = DEFAULT_GAME_CONFIG;
    const setup = makeSetup(["a", "b"]);
    expect(checkStart({ round: 1, slot: makeSlot() }, runtime, {}, setup, cfg)).toBe(
      "already-playing"
    );
    expect(checkStart(idle, undefined, {}, setup, cfg)).toBe("unknown-game");
    expect(checkStart(idle, runtime, { big: "x".repeat(10_001) }, setup, cfg)).toBe(
      "invalid-settings"
    );
    const crowded = makeSetup(["a", "b"], { spectators: [pid("s")] });
    expect(checkStart(idle, runtime, {}, crowded, { ...cfg, maxSlotPlayers: 2 })).toBe(
      "too-many-players"
    );
  });

  it("accepts a normal start", () => {
    expect(
      checkStart(idle, runtime, { rounds: 1 }, makeSetup(["a", "b"]), DEFAULT_GAME_CONFIG)
    ).toBeUndefined();
  });
});

describe("recordNames", () => {
  const cfg = DEFAULT_GAME_CONFIG;
  const slot = makeSlot({ setup: makeSetup(["a"]) });

  it("returns the same slot when nothing changed", () => {
    const same = { players: [{ id: pid("a"), name: "A", here: true }], removed: [] };
    expect(recordNames(slot, same, cfg)).toBe(slot);
  });

  it("records new and changed names, cut to maxNameChars", () => {
    const out = recordNames(
      slot,
      { players: [{ id: pid("a"), name: "x".repeat(100), here: true }], removed: [] },
      cfg
    );
    expect(out.setup.names.a).toHaveLength(64);
    const fresh = recordNames(slot, observation([["b", true]]), cfg);
    expect(fresh.setup.names).toEqual({ a: "A", b: "b" });
  });

  it("a new name past the slot cap is not recorded", () => {
    const out = recordNames(slot, observation([["b", true]]), { ...cfg, maxSlotPlayers: 1 });
    expect(out).toBe(slot);
  });
});

describe("newcomers", () => {
  it("here, unknown to the slot and not removed on purpose", () => {
    const slot = makeSlot({ setup: makeSetup(["a"], { spectators: [pid("s")] }) });
    const obs = observation(
      [
        ["a", true],
        ["s", true],
        ["n", true],
        ["m", false],
        ["r", true],
      ],
      ["r"]
    );
    expect(newcomers(slot, obs)).toEqual(["n"]);
  });
});

describe("lateJoin", () => {
  const env = slotEnv();

  it("free-for-all: the game admits the newcomer as a participant", () => {
    const out = lateJoin(makeSlot(), pid("c"), runtime, env);
    expect(out.slot.setup.participants).toEqual(["a", "b", "c"]);
    expect(out.writes).toEqual([]);
  });

  it("at the game's player cap the newcomer spectates", () => {
    const slot = makeSlot({ setup: makeSetup(["a", "b", "c", "d"]) });
    const out = lateJoin(slot, pid("e"), runtime, env);
    expect(out.slot.setup.participants).toHaveLength(4);
    expect(out.slot.setup.spectators).toEqual(["e"]);
  });

  it("at the slot cap the newcomer is not placed at all", () => {
    const slot = makeSlot({ setup: makeSetup(["a", "b", "c", "d"]) });
    const out = lateJoin(
      slot,
      pid("e"),
      runtime,
      slotEnv({ config: { ...DEFAULT_GAME_CONFIG, maxSlotPlayers: 4 } })
    );
    expect(out.slot).toBe(slot);
  });

  it("teams: gets the team the game chose, or spectates when that team does not exist", () => {
    const teams = makeSetup(["a", "b"], {
      mode: "teams",
      teamIds: ["red", "blue"],
      teams: { a: "red", b: "blue" },
    });
    const ok = lateJoin(makeSlot({ setup: teams }), pid("c"), runtime, env);
    expect(ok.slot.setup.teams.c).toBe("red");
    expect(ok.slot.setup.participants).toContain("c");

    const noRed = { ...teams, teamIds: ["blue"] };
    const spectated = lateJoin(makeSlot({ setup: noRed }), pid("c"), runtime, env);
    expect(spectated.slot.setup.spectators).toEqual(["c"]);
  });

  it("a game without `late` always spectates", async () => {
    const { otherGame } = await import("./test-kit");
    const out = lateJoin(makeSlot(), pid("c"), otherGame.runtime, env);
    expect(out.slot.setup.spectators).toEqual(["c"]);
  });
});

describe("nextWakeAt", () => {
  const cfg = DEFAULT_GAME_CONFIG;
  const presence = (since: Record<string, number>) => ({
    presence: { away: [], since, paused: false, forced: false },
  });

  it("nothing to wake for", () => {
    expect(nextWakeAt(null, runtime, cfg)).toBeUndefined();
    expect(nextWakeAt(makeSlot(), undefined, cfg)).toBeUndefined();
    expect(nextWakeAt(makeSlot(), runtime, cfg)).toBeUndefined();
  });

  it("the away boundary is since + awayAfterMs", () => {
    expect(nextWakeAt(makeSlot({ x: presence({ a: 500 }) }), runtime, cfg)).toBe(10_500);
  });

  it("the earliest of away boundaries and running timer deadlines; frozen timers ignored", () => {
    const running = { t1: { timer: "ding", payload: undefined, deadlineAt: 2_000 } };
    const frozen = { t1: { timer: "ding", payload: undefined, deadlineAt: 100, frozenMs: 500 } };
    expect(
      nextWakeAt(makeSlot({ x: { ...presence({ a: 500 }), timers: running } }), runtime, cfg)
    ).toBe(2_000);
    expect(nextWakeAt(makeSlot({ x: { timers: frozen } }), runtime, cfg)).toBeUndefined();
  });
});

describe("finish", () => {
  it("clears the slot, advances the round and remembers the game", () => {
    expect(finish({ round: 3, slot: makeSlot() })).toEqual({
      round: 4,
      last: { gameId: "probe", settings: { rounds: 1 } },
      slot: null,
    });
  });
  it("is a no-op without a slot", () => {
    const idle = { round: 3, slot: null };
    expect(finish(idle)).toBe(idle);
  });
});
