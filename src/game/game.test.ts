import { describe, expect, it } from "vitest";
import { s } from "@/kernel";
import { GameHarness } from "./harness";
import * as api from "./index";
import { defineLocalState } from "./index";
import type { GameHandle } from "./model";
import { otherGame, pid, probeGame, type ProbeTypes } from "./test-kit";

const notes = defineLocalState({
  id: "notes",
  schema: s.object({ text: s.string({ max: 20 }) }),
  initial: () => ({ text: "" }),
});

async function table(
  opts: { seated?: string[]; setup?: string[]; extra?: Record<string, unknown> } = {}
) {
  const h = new GameHarness();
  const a = h.addPeer("a");
  const b = h.addPeer("b");
  const c = h.addPeer("c");
  const seated = opts.seated ?? ["a", "b", "c"];
  h.seat(...seated);
  h.setup(opts.setup ?? seated, opts.extra);
  // Handles exist before the game starts, so notices are seen from the start.
  const ga = a.game.actions.handle(probeGame);
  const gb = b.game.actions.handle(probeGame);
  const gc = c.game.actions.handle(probeGame);
  await h.settle();
  const send = async (g: GameHandle<ProbeTypes>, cmd: ProbeTypes["command"]) => {
    const p = g.send(cmd);
    await h.settle();
    return p;
  };
  const begin = async () => {
    const r = await a.game.actions.start(probeGame, { rounds: 1 });
    await h.settle();
    return r;
  };
  return { h, a, b, c, ga, gb, gc, send, begin };
}

describe("public surface", () => {
  it("exports exactly the documented runtime values", () => {
    expect(Object.keys(api).sort()).toEqual([
      "DEFAULT_GAME_CONFIG",
      "createGame",
      "defineGame",
      "defineLocalState",
    ]);
  });
});

describe("start, views and end", () => {
  it("before a game: no active game and no view", async () => {
    const t = await table();
    expect(t.b.game.state.active.get()).toBeUndefined();
    expect(t.gb.view.get()).toBeUndefined();
    expect(t.b.game.state.round.get()).toBe(1);
  });

  it("the host starts a game; every peer sees it", async () => {
    const t = await table();
    expect(await t.begin()).toEqual({ ok: true, value: undefined });
    for (const p of [t.a, t.b, t.c]) {
      expect(p.game.state.active.get()).toEqual({ gameId: "probe", round: 1, supported: true });
    }
    const view = t.gb.view.get();
    expect(view?.state).toEqual({ n: 0 });
    expect(view?.settings).toEqual({ rounds: 1 });
    expect(view?.players.map((p) => p.name)).toEqual(["a", "b", "c"]);
    expect(view?.me).toMatchObject({ playerId: "b", role: "player" });
  });

  it("handles are memoized per game", async () => {
    const t = await table();
    expect(t.a.game.actions.handle(probeGame)).toBe(t.ga);
  });

  it("start rejections", async () => {
    const t = await table();
    expect(await t.b.game.actions.start(probeGame, { rounds: 1 })).toEqual({
      ok: false,
      reason: "not-host",
    });
    expect(await t.a.game.actions.start(probeGame, { rounds: 99 })).toEqual({
      ok: false,
      reason: "invalid-settings",
    });
    await t.begin();
    expect(await t.a.game.actions.start(probeGame, { rounds: 1 })).toEqual({
      ok: false,
      reason: "already-playing",
    });

    const few = await table({ setup: ["a"] });
    expect(await few.a.game.actions.start(probeGame, { rounds: 1 })).toEqual({
      ok: false,
      reason: "too-few-players",
    });
    const many = await table({ setup: ["a", "b", "c", "d", "e"] });
    expect(await many.a.game.actions.start(probeGame, { rounds: 1 })).toEqual({
      ok: false,
      reason: "too-many-players",
    });
  });

  it("a game this peer was not given is `unknown-game`", async () => {
    const h = new GameHarness();
    const a = h.addPeer("a", { games: [] });
    h.seat("a", "b");
    h.setup(["a", "b"]);
    await h.settle();
    expect(await a.game.actions.start(probeGame, { rounds: 1 })).toEqual({
      ok: false,
      reason: "unknown-game",
    });
  });

  it("end: guest refused, nothing to end, then the game ends for everyone with the round advanced", async () => {
    const t = await table();
    expect(await t.a.game.actions.end()).toEqual({ ok: false, reason: "not-playing" });
    await t.begin();
    expect(await t.b.game.actions.end()).toEqual({ ok: false, reason: "not-host" });
    expect((await t.a.game.actions.end()).ok).toBe(true);
    await t.h.settle();
    for (const p of [t.a, t.b, t.c]) {
      expect(p.game.state.active.get()).toBeUndefined();
      expect(p.game.state.round.get()).toBe(2);
      expect(p.game.state.last.get()).toEqual({ gameId: "probe", settings: { rounds: 1 } });
    }
    expect(t.gb.view.get()).toBeUndefined();
  });

  it("an `end` effect from a player command ends the game in the same commit", async () => {
    const t = await table();
    await t.begin();
    expect((await t.send(t.gb, { type: "finish" })).ok).toBe(true);
    expect(t.c.game.state.active.get()).toBeUndefined();
    expect(t.c.game.state.round.get()).toBe(2);
  });
});

describe("the play gate", () => {
  it("no game running", async () => {
    const t = await table();
    expect(await t.send(t.gb, { type: "inc" })).toEqual({ ok: false, reason: "no-active-game" });
  });

  it("commands run on the host and every peer converges", async () => {
    const t = await table();
    await t.begin();
    expect((await t.send(t.gb, { type: "inc" })).ok).toBe(true);
    await t.send(t.gc, { type: "inc" });
    for (const g of [t.ga, t.gb, t.gc]) expect(g.view.get()?.state).toEqual({ n: 2 });
  });

  it("wrong game, host-only, unknown command and invalid payload", async () => {
    const t = await table();
    await t.begin();
    const other = t.b.game.actions.handle(otherGame);
    const wrong = other.send({ type: "noop" });
    await t.h.settle();
    expect(await wrong).toEqual({ ok: false, reason: "wrong-game" });
    expect(await t.send(t.gb, { type: "boss" })).toEqual({ ok: false, reason: "host-only" });
    expect((await t.send(t.ga, { type: "boss" })).ok).toBe(true);
    expect(t.gc.view.get()?.state).toEqual({ n: 10 });
    expect(await t.send(t.gb, { type: "zzz" } as never)).toEqual({
      ok: false,
      reason: "unknown-command",
    });
    expect(await t.send(t.gb, { type: "say" } as never)).toEqual({ ok: false, reason: "invalid" });
  });

  it("a peer that is not a participant is a spectator and cannot play", async () => {
    const t = await table({ seated: ["a", "b"] });
    await t.begin();
    expect(await t.send(t.gc, { type: "inc" })).toEqual({ ok: false, reason: "not-a-participant" });
    expect(t.gc.view.get()?.me.role).toBe("spectator");
    expect(t.gc.view.get()?.players.map((p) => p.name)).toEqual(["a", "b"]);
    expect((await t.send(t.gc, { type: "say", text: "hi" })).ok).toBe(true); // `anyone`
  });
});

describe("late joiners and removal", () => {
  it("free-for-all: a late joiner becomes a participant", async () => {
    const t = await table({ seated: ["a", "b"] });
    await t.begin();
    t.h.seat("c");
    await t.h.settle();
    const view = t.gc.view.get();
    expect(view?.players.find((p) => p.id === "c")).toMatchObject({ name: "c", role: "player" });
    expect(view?.me.role).toBe("player");
    expect((await t.send(t.gc, { type: "inc" })).ok).toBe(true);
  });

  it("teams: a late joiner gets the game's team", async () => {
    const t = await table({
      seated: ["a", "b"],
      extra: { mode: "teams", teamIds: ["red", "blue"], teams: { a: "red", b: "blue" } },
    });
    await t.begin();
    t.h.seat("c");
    await t.h.settle();
    const setup = t.gb.view.get()?.setup as { teams: Record<string, string> };
    expect(setup.teams).toEqual({ a: "red", b: "blue", c: "red" });
    expect(t.gc.view.get()?.me.team).toBe("red");
  });

  it("a kicked or banned participant becomes a spectator at once", async () => {
    const t = await table();
    await t.begin();
    t.h.remove("c");
    await t.h.settle();
    expect(t.gb.view.get()?.players.find((p) => p.id === "c")?.role).toBe("spectator");
    expect(t.gc.view.get()?.me.role).toBe("spectator");
    expect(await t.send(t.gc, { type: "inc" })).toEqual({ ok: false, reason: "not-a-participant" });
  });
});

describe("away, pause and resume", () => {
  it("a missing participant is away after awayAfterMs, and returning restores it", async () => {
    const t = await table();
    await t.begin();
    t.h.setHere("c", false);
    await t.h.advance(9_000);
    expect(t.gb.view.get()?.away).toEqual([]);
    await t.h.advance(1_500);
    for (const g of [t.ga, t.gb, t.gc]) expect(g.view.get()?.away).toEqual(["c"]);
    expect(t.gb.view.get()?.paused).toBe(false); // two still present
    t.h.setHere("c", true);
    await t.h.settle();
    expect(t.gb.view.get()?.away).toEqual([]);
    expect(t.gb.view.get()?.me.role).toBe("player");
  });

  it("below minPresent the game pauses; the host can continue anyway", async () => {
    const t = await table();
    await t.begin();
    t.h.setHere("c", false);
    await t.h.advance(10_500);
    t.h.setHere("b", false);
    await t.h.advance(10_500);
    expect(t.gc.view.get()?.paused).toBe(true);
    expect(await t.send(t.gc, { type: "inc" })).toEqual({ ok: false, reason: "paused" });

    expect(await t.gb.continueAnyway()).toEqual({ ok: false, reason: "not-host" });
    expect((await t.ga.continueAnyway()).ok).toBe(true);
    await t.h.settle();
    expect(t.gc.view.get()?.paused).toBe(false);
    expect((await t.send(t.gc, { type: "inc" })).ok).toBe(true);
    expect(await t.ga.continueAnyway()).toEqual({ ok: false, reason: "not-paused" });
  });

  it("the game resumes by itself when enough players are back", async () => {
    const t = await table();
    await t.begin();
    t.h.setHere("c", false);
    await t.h.advance(10_500);
    t.h.setHere("b", false);
    await t.h.advance(10_500);
    expect(t.ga.view.get()?.paused).toBe(true);
    t.h.setHere("c", true);
    await t.h.settle();
    expect(t.ga.view.get()?.paused).toBe(false);
  });
});

describe("timers", () => {
  it("a started timer fires exactly once after its delay", async () => {
    const t = await table();
    await t.begin();
    await t.send(t.gb, { type: "timer" });
    expect(t.gc.view.get()?.timers).toMatchObject([
      { id: "t1", timer: "ding", paused: false, deadlineAt: 1_000 },
    ]);
    await t.h.advance(900);
    expect(t.gb.view.get()?.state).toEqual({ n: 0 });
    await t.h.advance(200);
    for (const g of [t.ga, t.gb, t.gc]) {
      expect(g.view.get()?.state).toEqual({ n: 100 });
      expect(g.view.get()?.timers).toEqual([]);
    }
    await t.h.advance(5_000);
    expect(t.gb.view.get()?.state).toEqual({ n: 100 });
  });
});

describe("notices and events", () => {
  it("a notice reaches every peer once, from state", async () => {
    const t = await table();
    const got: Record<string, unknown[]> = { a: [], b: [], c: [] };
    t.ga.noticed.on((e) => got.a?.push(e));
    t.gb.noticed.on((e) => got.b?.push(e));
    t.gc.noticed.on((e) => got.c?.push(e));
    await t.begin();
    await t.send(t.gb, { type: "say", text: "hi" });
    for (const name of ["a", "b", "c"]) expect(got[name]).toEqual([{ type: "said", text: "hi" }]);
    expect(t.gc.view.get()?.notices).toEqual([{ type: "said", text: "hi" }]);
    await t.send(t.gb, { type: "inc" });
    expect(got.c).toHaveLength(1);
  });

  it("ephemeral events: only while a game runs, validated, delivered locally too", async () => {
    const t = await table();
    expect(t.ga.broadcast({ type: "said", text: "x" })).toBe(false);
    await t.begin();
    const got: string[] = [];
    t.ga.events.on((e) => got.push(`a:${e.event.text}`));
    t.gb.events.on((e) => got.push(`b:${e.event.text}`));
    t.gc.events.on((e) => got.push(`c:${e.event.text}`));
    expect(t.ga.broadcast({ type: "said", text: "yo" })).toBe(true);
    expect(t.ga.broadcast({ type: "said", text: "x".repeat(21) })).toBe(false);
    await t.h.settle();
    expect(got.sort()).toEqual(["a:yo", "b:yo", "c:yo"]);
  });

  it("sendTo reaches one player; a player with no peer is refused", async () => {
    const t = await table();
    await t.begin();
    const got: string[] = [];
    t.gb.events.on(() => got.push("b"));
    t.gc.events.on(() => got.push("c"));
    expect(t.ga.sendTo(pid("b"), { type: "said", text: "hi" })).toBe(true);
    expect(t.ga.sendTo(pid("zzz"), { type: "said", text: "hi" })).toBe(false);
    await t.h.settle();
    expect(got).toEqual(["b"]);
  });
});

describe("private pieces", () => {
  it("a piece goes only to its owner and is replaced with a new revision", async () => {
    const t = await table();
    await t.begin();
    await t.send(t.gb, { type: "deal" });
    expect(t.gb.view.get()?.me.private).toBe("s0");
    expect(t.gc.view.get()?.me.private).toBeUndefined();
    expect(t.ga.view.get()?.me.private).toBeUndefined();
    await t.send(t.gc, { type: "inc" });
    await t.send(t.gb, { type: "deal" });
    expect(t.gb.view.get()?.me.private).toBe("s1");
  });
});

describe("local state", () => {
  it("is per round and device, and only while a game runs", async () => {
    const t = await table();
    const local = t.gb.local(notes);
    expect(t.gb.local(notes)).toBe(local);
    local.set({ text: "ignored" });
    expect(local.value.get()).toEqual({ text: "" });

    await t.begin();
    local.set({ text: "hi" });
    expect(local.value.get()).toEqual({ text: "hi" });
    expect(t.b.device.get("game-local:room1:probe:1:b:notes")).toBe('{"text":"hi"}');

    await t.a.game.actions.end();
    await t.h.settle();
    await t.begin();
    expect(local.value.get()).toEqual({ text: "" }); // round 2
  });
});

describe("host failover", () => {
  it("the new host keeps the slot, fires an overdue timer and keeps playing", async () => {
    const t = await table();
    await t.begin();
    await t.send(t.gb, { type: "inc" });
    await t.send(t.gb, { type: "timer" });
    t.h.kill(t.a);
    t.h.setHost("b");
    t.h.setHere("a", false);
    await t.h.advance(5_000);
    for (const g of [t.gb, t.gc]) {
      expect(g.view.get()?.state).toEqual({ n: 101 });
      expect(g.view.get()?.timers).toEqual([]);
    }
    expect((await t.send(t.gc, { type: "inc" })).ok).toBe(true);
    expect(t.gb.view.get()?.state).toEqual({ n: 102 });

    await t.h.advance(11_000);
    expect(t.gb.view.get()?.away).toEqual(["a"]);
    expect(t.gc.view.get()?.away).toEqual(["a"]);
  });
});

describe("a game this build does not know", () => {
  it("keeps syncing round and last, and reports the game as unsupported", async () => {
    const h = new GameHarness();
    const a = h.addPeer("a");
    h.seat("a", "b");
    h.setup(["a", "b"]);
    await h.settle();
    await a.game.actions.start(probeGame, { rounds: 1 });
    const c = h.addPeer("c", { games: [] });
    await h.settle();
    expect(c.game.state.active.get()).toEqual({ gameId: "probe", round: 1, supported: false });
    await a.game.actions.end();
    await h.settle();
    expect(c.game.state.round.get()).toBe(2);
    expect(c.game.state.last.get()).toEqual({ gameId: "probe", settings: { rounds: 1 } });
  });
});
