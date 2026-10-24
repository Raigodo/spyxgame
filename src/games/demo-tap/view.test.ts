import { describe, expect, it } from "vitest";
import { makeView } from "@/game/fakes";
import type { ViewPlayer } from "@/game";
import { as, type PlayerId } from "@/kernel";
import type { TapState, TapTypes } from "./schemas";
import { standings, teamTotals } from "./view";

const p = as<PlayerId>;
const pl = (id: string, o: Partial<ViewPlayer> = {}): ViewPlayer => ({
  id: p(id),
  name: id.toUpperCase(),
  role: "player",
  away: false,
  ...o,
});

const ffa = (state: TapState, players: ViewPlayer[]) =>
  makeView<TapTypes>({
    state,
    settings: { goal: 5 },
    players,
    setup: { mode: "free-for-all", participants: players.map((x) => x.id) } as never,
  });

describe("standings", () => {
  it("participants by score, highest first, ties keep join order, spectators left out", () => {
    const view = ffa({ scores: { a: 1, b: 3, c: 1 } }, [
      pl("a"),
      pl("b"),
      pl("c"),
      pl("s", { role: "spectator" }),
    ]);
    expect(standings(view).map((r) => [r.id, r.score])).toEqual([
      ["b", 3],
      ["a", 1],
      ["c", 1],
    ]);
  });
  it("a player with no score counts zero; away is passed through; no team in free-for-all", () => {
    const rows = standings(ffa({ scores: {} }, [pl("a", { away: true })]));
    expect(rows).toEqual([{ id: "a", name: "A", score: 0, away: true }]);
    expect("team" in (rows[0] ?? {})).toBe(false);
  });
  it("teams mode adds the team", () => {
    const view = makeView<TapTypes>({
      state: { scores: { a: 2 } },
      settings: { goal: 5 },
      players: [pl("a")],
      setup: {
        mode: "teams",
        teamIds: ["red"],
        teams: { a: "red" },
        participants: [p("a")],
      } as never,
    });
    expect(standings(view)[0]?.team).toBe("red");
  });
});

describe("teamTotals", () => {
  it("undefined in free-for-all", () => {
    expect(teamTotals(ffa({ scores: {} }, [pl("a")]))).toBeUndefined();
  });
  it("sums per team, includes empty teams, highest first", () => {
    const view = makeView<TapTypes>({
      state: { scores: { a: 2, b: 3, c: 1 } },
      settings: { goal: 5 },
      players: [pl("a"), pl("b"), pl("c")],
      setup: {
        mode: "teams",
        teamIds: ["red", "blue", "green"],
        teams: { a: "red", b: "blue", c: "red" },
        participants: [p("a"), p("b"), p("c")],
      } as never,
    });
    expect(teamTotals(view)).toEqual([
      { team: "red", total: 3 },
      { team: "blue", total: 3 },
      { team: "green", total: 0 },
    ]);
  });
});
