import { describe, expect, it } from "vitest";
import { GameHarness } from "@/game/harness";
import { spyGame } from "./definition";
import { notesSchema } from "./schemas";
import { spyNotes } from "./notes";
import type { SpyCommand } from "./schemas";

const SETTINGS = { wordsPerPlayer: 3, minWords: 5 };

async function table() {
  const h = new GameHarness();
  const a = h.addPeer("a", { games: [spyGame] });
  const b = h.addPeer("b", { games: [spyGame] });
  const c = h.addPeer("c", { games: [spyGame] });
  h.seat("a", "b", "c");
  h.setup(["a", "b", "c"]);
  const handles = {
    a: a.game.actions.handle(spyGame),
    b: b.game.actions.handle(spyGame),
    c: c.game.actions.handle(spyGame),
  };
  await h.settle();
  const send = async (who: "a" | "b" | "c", cmd: SpyCommand) => {
    const p = handles[who].send(cmd);
    await h.settle();
    return p;
  };
  const state = () => handles.a.view.get()!.state;
  const fillPool = async (words = ["w1", "w2", "w3", "w4", "w5"]) => {
    const owners = ["a", "a", "b", "b", "c"] as const;
    for (const [i, text] of words.entries()) await send(owners[i % 5]!, { type: "addWord", text });
  };
  const begin = async () => {
    await a.game.actions.start(spyGame, SETTINGS);
    await h.settle();
  };
  return { h, a, b, c, handles, send, state, fillPool, begin };
}

describe("spy: a full round", () => {
  it("collect words, talk, decide, vote, last chance, end", async () => {
    const t = await table();
    await t.begin();
    expect(t.state().phase).toBe("collecting");
    await t.fillPool();
    expect(t.state().words).toHaveLength(5);

    expect((await t.send("a", { type: "begin" })).ok).toBe(true);
    const begun = t.state();
    expect(begun.phase).toBe("talking");
    expect(begun.order).toHaveLength(3);
    const spy = begun.spyId as "a" | "b" | "c";
    expect(begun.order[0]).not.toBe(spy);

    for (let i = 0; i < 3; i++) {
      const s = t.state();
      expect((await t.send(s.order[s.turn] as "a", { type: "endTurn" })).ok).toBe(true);
    }
    expect(t.state().phase).toBe("deciding");

    for (const id of ["a", "b", "c"] as const) await t.send(id, { type: "decide", choice: "vote" });
    expect(t.state().phase).toBe("voting");

    const nonSpies = (["a", "b", "c"] as const).filter((id) => id !== spy);
    for (const id of ["a", "b", "c"] as const) {
      const target = id === spy ? nonSpies[0]! : spy;
      expect((await t.send(id, { type: "vote", target })).ok).toBe(true);
    }
    expect(t.state()).toMatchObject({ phase: "lastChance", accusedId: spy });

    expect((await t.send(spy, { type: "giveUp" })).ok).toBe(true);
    expect(t.state()).toMatchObject({
      phase: "ended",
      result: { winner: "players", reason: "spy-caught" },
    });
    for (const g of Object.values(t.handles)) expect(g.view.get()?.state.phase).toBe("ended");

    expect((await t.a.game.actions.end()).ok).toBe(true);
    await t.h.settle();
    expect(t.b.game.state.active.get()).toBeUndefined();
  });
});

describe("spy: rules through the gate", () => {
  it("begin is host-only and needs enough words", async () => {
    const t = await table();
    await t.begin();
    expect(await t.send("b", { type: "begin" })).toEqual({ ok: false, reason: "host-only" });
    await t.fillPool(["w1", "w2", "w3"]);
    expect(await t.send("a", { type: "begin" })).toEqual({ ok: false, reason: "too-few-words" });
  });

  it("word rules: duplicates, limits, removal of someone else's word", async () => {
    const t = await table();
    await t.begin();
    expect((await t.send("a", { type: "addWord", text: "cat" })).ok).toBe(true);
    expect(await t.send("b", { type: "addWord", text: "CAT" })).toEqual({
      ok: false,
      reason: "duplicate-word",
    });
    expect(await t.send("b", { type: "removeWord", wordId: "w1" })).toEqual({
      ok: false,
      reason: "not-your-word",
    });
    expect(await t.send("a", { type: "addWord", text: "   " })).toEqual({
      ok: false,
      reason: "invalid-word",
    });
  });

  it("only the speaker ends the turn; the host can skip; forceAdvance is host-only", async () => {
    const t = await table();
    await t.begin();
    await t.fillPool();
    await t.send("a", { type: "begin" });
    const s = t.state();
    const notSpeaker = s.order[1] as "a";
    expect(await t.send(notSpeaker, { type: "endTurn" })).toEqual({
      ok: false,
      reason: "not-your-turn",
    });
    expect((await t.send("a", { type: "skipTurn" })).ok).toBe(true);
    expect(t.state().turn).toBe(1);
    expect(await t.send("b", { type: "forceAdvance" })).toEqual({ ok: false, reason: "host-only" });
    expect(await t.send("a", { type: "forceAdvance" })).toEqual({
      ok: false,
      reason: "nothing-to-advance",
    });
  });

  it("the spy claims the word and the others vote on it", async () => {
    const t = await table();
    await t.begin();
    await t.fillPool();
    await t.send("a", { type: "begin" });
    const spy = t.state().spyId as "a" | "b" | "c";
    const others = (["a", "b", "c"] as const).filter((id) => id !== spy);
    expect((await t.send(others[0]!, { type: "claimWord" })).ok).toBe(false);
    expect((await t.send(spy, { type: "claimWord" })).ok).toBe(true);
    await t.send(others[0]!, { type: "claimVote", correct: true });
    await t.send(others[1]!, { type: "claimVote", correct: true });
    expect(t.state()).toMatchObject({
      phase: "ended",
      result: { winner: "spy", reason: "spy-guessed" },
    });
  });
});

describe("spy: away players", () => {
  it("an away speaker is skipped, and with fewer than three players the game pauses", async () => {
    const t = await table();
    await t.begin();
    await t.fillPool();
    await t.send("a", { type: "begin" });
    const speaker = t.state().order[0] as string;
    t.h.setHere(speaker, false);
    await t.h.advance(11_000);
    expect(t.state().turn).toBe(1);
    const view = t.handles.a.view.get();
    expect(view?.away).toEqual([speaker]);
    expect(view?.paused).toBe(true); // minPresent 3
  });
});

describe("spy: local notes", () => {
  it("are kept on the device, per round, through handle.local", async () => {
    const t = await table();
    await t.begin();
    const notes = t.handles.b.local(spyNotes);
    notes.set({ pad: "it is c", marks: { c: "suspect" }, remarks: {} });
    expect(notes.value.get().marks).toEqual({ c: "suspect" });
    const raw = t.b.device.get("game-local:room1:spy:1:b:notes");
    expect(notesSchema.parse(JSON.parse(raw!))?.pad).toBe("it is c");
    expect(t.handles.c.local(spyNotes).value.get().pad).toBe("");
  });
});
