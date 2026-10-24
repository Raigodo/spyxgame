import { describe, expect, it } from "vitest";
import { GameHarness } from "@/game/harness";
import { demoTap } from "./definition";
import { standings, teamTotals } from "./view";

async function race(seated = ["a", "b"], extra: Record<string, unknown> = {}) {
  const h = new GameHarness();
  const a = h.addPeer("a", { games: [demoTap] });
  const b = h.addPeer("b", { games: [demoTap] });
  const c = h.addPeer("c", { games: [demoTap] });
  h.seat(...seated);
  h.setup(seated, extra);
  const ga = a.game.actions.handle(demoTap);
  const gb = b.game.actions.handle(demoTap);
  const gc = c.game.actions.handle(demoTap);
  await h.settle();
  const begin = async (goal = 2) => {
    const r = await a.game.actions.start(demoTap, { goal });
    await h.settle();
    return r;
  };
  const tap = async (g: typeof ga) => {
    const p = g.send({ type: "tap" });
    await h.settle();
    return p;
  };
  return { h, a, b, c, ga, gb, gc, begin, tap };
}

describe("demo-tap: a race", () => {
  it("starts with everyone at zero, taps count, the first to the goal wins", async () => {
    const t = await race();
    expect((await t.begin(2)).ok).toBe(true);
    expect(t.gb.view.get()?.state).toEqual({ scores: { a: 0, b: 0 } });
    await t.tap(t.gb);
    await t.tap(t.ga);
    await t.tap(t.gb);
    for (const g of [t.ga, t.gb]) {
      expect(g.view.get()?.state).toEqual({ scores: { a: 1, b: 2 }, winner: "b" });
    }
    const rows = standings(t.gb.view.get()!);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("after the win a tap is rejected with `game-over`", async () => {
    const t = await race();
    await t.begin(1);
    await t.tap(t.gb);
    expect(await t.tap(t.ga)).toEqual({ ok: false, reason: "game-over" });
  });

  it("a spectator cannot tap", async () => {
    const t = await race(["a", "b"]);
    await t.begin();
    expect(await t.tap(t.gc)).toEqual({ ok: false, reason: "not-a-participant" });
  });

  it("goal of one makes the first tap the end of the race, and the host can end the game", async () => {
    const t = await race();
    await t.begin(1);
    await t.tap(t.ga);
    expect((await t.a.game.actions.end()).ok).toBe(true);
    await t.h.settle();
    expect(t.b.game.state.active.get()).toBeUndefined();
    expect(t.b.game.state.last.get()).toEqual({ gameId: "demo-tap", settings: { goal: 1 } });
  });
});

describe("demo-tap: late joiners", () => {
  it("free-for-all: a late joiner is admitted at zero and can tap", async () => {
    const t = await race(["a", "b"]);
    await t.begin(5);
    t.h.seat("c");
    await t.h.settle();
    expect(t.gc.view.get()?.state.scores.c).toBe(0);
    expect(t.gc.view.get()?.me.role).toBe("player");
    expect((await t.tap(t.gc)).ok).toBe(true);
  });

  it("teams: a late joiner spectates (no team to put them on)", async () => {
    const t = await race(["a", "b"], {
      mode: "teams",
      teamIds: ["red", "blue"],
      teams: { a: "red", b: "blue" },
    });
    await t.begin(5);
    t.h.seat("c");
    await t.h.settle();
    expect(t.gc.view.get()?.me.role).toBe("spectator");
    expect(t.gc.view.get()?.state.scores.c).toBeUndefined();
  });
});

describe("demo-tap: teams", () => {
  it("team totals follow the taps", async () => {
    const t = await race(["a", "b"], {
      mode: "teams",
      teamIds: ["red", "blue"],
      teams: { a: "red", b: "blue" },
    });
    await t.begin(10);
    await t.tap(t.ga);
    await t.tap(t.ga);
    await t.tap(t.gb);
    expect(teamTotals(t.gb.view.get()!)).toEqual([
      { team: "red", total: 2 },
      { team: "blue", total: 1 },
    ]);
  });

  it("a game started in teams mode is accepted, in free-for-all too (both modes allowed)", async () => {
    const ffa = await race();
    expect((await ffa.begin()).ok).toBe(true);
    const teams = await race(["a", "b"], {
      mode: "teams",
      teamIds: ["x"],
      teams: { a: "x", b: "x" },
    });
    expect((await teams.begin()).ok).toBe(true);
  });
});

describe("demo-tap: emotes and settings", () => {
  it("an emote reaches everyone, an invalid one is refused locally", async () => {
    const t = await race();
    await t.begin();
    const got: string[] = [];
    t.ga.events.on((e) => got.push(`a:${e.event.emoji}`));
    t.gb.events.on((e) => got.push(`b:${e.event.emoji}`));
    expect(t.gb.broadcast({ type: "emote", emoji: "ok" })).toBe(true);
    expect(t.gb.broadcast({ type: "emote", emoji: "" })).toBe(false);
    await t.h.settle();
    expect(got.sort()).toEqual(["a:ok", "b:ok"]);
  });

  it("invalid settings are refused at start", async () => {
    const t = await race();
    expect(await t.a.game.actions.start(demoTap, { goal: 0 })).toEqual({
      ok: false,
      reason: "invalid-settings",
    });
  });
});
