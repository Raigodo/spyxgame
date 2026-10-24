// Test support for the game feature: a probe game that exercises every framework capability
// (commands, host commands, notices, timers, private pieces, late join, pause), and slot builders.
// Not exported from index.ts.

import { as, fail, ok, s, type PlayerId } from "@/kernel";
import { DEFAULT_GAME_CONFIG } from "./config";
import { defineGame } from "./define";
import type { GameTypes, Observation, ParseEnv, Slot, SlotEnv, SlotSetup } from "./model";
import { initialX } from "./slot";

export type ProbeCommand =
  | { type: "inc" }
  | { type: "timer" }
  | { type: "say"; text: string }
  | { type: "finish" }
  | { type: "deal" }
  | { type: "boss" };

export type ProbeTypes = GameTypes & {
  settings: { rounds: number };
  state: { n: number };
  command: ProbeCommand;
  event: { type: "said"; text: string };
  reject: "too-high";
  private: string;
};

const settings = s.object({ rounds: s.int({ min: 1, max: 5 }) });
const state = s.object({ n: s.int({ min: 0, max: 100_000 }) });

export const probeGame = defineGame<ProbeTypes>({
  id: "probe",
  modes: ["free-for-all", "teams"],
  players: { min: 2, max: 4 },
  settings,
  state,
  init: () => ({ n: 0 }),
  commands: {
    inc: {
      schema: s.object({ type: s.literal("inc") }),
      reduce: (a) => (a.state.n >= 1000 ? fail("too-high") : ok({ state: { n: a.state.n + 1 } })),
    },
    timer: {
      schema: s.object({ type: s.literal("timer") }),
      reduce: (a) =>
        ok({
          state: a.state,
          effects: [{ type: "startTimer", id: "t1", timer: "ding", afterMs: 1_000 }],
        }),
    },
    say: {
      who: "anyone",
      schema: s.object({ type: s.literal("say"), text: s.string({ max: 20 }) }),
      reduce: (a, c) =>
        ok({ state: a.state, effects: [{ type: "emit", event: { type: "said", text: c.text } }] }),
    },
    finish: {
      schema: s.object({ type: s.literal("finish") }),
      reduce: (a) => ok({ state: a.state, effects: [{ type: "end" }] }),
    },
    deal: {
      schema: s.object({ type: s.literal("deal") }),
      reduce: (a) => ok({ state: a.state, private: { [a.sender.playerId]: `s${a.state.n}` } }),
    },
    boss: {
      who: "host",
      schema: s.object({ type: s.literal("boss") }),
      reduce: (a) => ok({ state: { n: a.state.n + 10 } }),
    },
  },
  events: {
    said: { schema: s.object({ type: s.literal("said"), text: s.string({ max: 20 }) }) },
  },
  timers: {
    ding: { reduce: (a) => ok({ state: { n: a.state.n + 100 } }) },
  },
  late: (a) => (a.setup.mode === "teams" ? { team: "red" } : {}),
  presence: { minPresent: 2, belowMin: "pause" },
  private: {
    schema: s.string({ max: 50 }),
    recover: (a) => `recovered-${a.playerId}`,
  },
});

export type OtherTypes = GameTypes & {
  settings: { rounds: number };
  state: { n: number };
  command: { type: "noop" };
  event: { type: "x" };
  reject: "no";
};

/** A minimal second game: no presence, no late, no private, default players. */
export const otherGame = defineGame<OtherTypes>({
  id: "other",
  modes: ["free-for-all"],
  settings,
  state,
  init: () => ({ n: 0 }),
  commands: {
    noop: { schema: s.object({ type: s.literal("noop") }), reduce: (a) => ok({ state: a.state }) },
  },
});

export const pid = (id: string): PlayerId => as<PlayerId>(id);

export function makeSetup(participants: string[], o: Partial<SlotSetup> = {}): SlotSetup {
  return {
    mode: "free-for-all",
    teams: {},
    participants: participants.map(pid),
    spectators: [],
    names: Object.fromEntries(participants.map((p) => [p, p.toUpperCase()])),
    ...o,
  };
}

export function makeSlot(
  o: { setup?: SlotSetup; state?: unknown; x?: Record<string, unknown> } = {}
): Slot {
  const setup = o.setup ?? makeSetup(["a", "b"]);
  return {
    gameId: "probe",
    version: 1,
    seed: 7,
    settings: { rounds: 1 },
    state: o.state ?? { n: 0 },
    setup,
    x: { ...initialX(setup), ...o.x },
  };
}

export const parseEnv = (): ParseEnv => ({
  config: DEFAULT_GAME_CONFIG,
  runtime: probeGame.runtime,
});

export function slotEnv(o: Partial<SlotEnv> = {}): SlotEnv {
  return { ...parseEnv(), now: 1_000, round: 1, private: { get: () => undefined }, ...o };
}

export const observation = (players: [string, boolean][], removed: string[] = []): Observation => ({
  players: players.map(([id, here]) => ({ id: pid(id), name: id, here })),
  removed: removed.map(pid),
});
