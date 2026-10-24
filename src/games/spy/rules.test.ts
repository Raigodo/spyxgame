import { describe, expect, it } from "vitest";
import {
  MAX_WORD_LENGTH,
  applyAddWord,
  applyBegin,
  applyClaimVote,
  applyClaimWord,
  applyDecide,
  applyEndTurn,
  applyForceAdvance,
  applyGiveUp,
  applyRemoveWord,
  applyVote,
  cleanWordText,
  createRng,
  currentSpeakerId,
  initialSpyState,
  nonSpyIds,
  pickSeeded,
  settle,
  settleState,
  shuffle,
  type SpyOutcome,
  type SpyState,
} from "./rules";

const P = ["a", "b", "c"];
const must = (o: SpyOutcome): SpyState => {
  if (!o.ok) throw new Error(`expected ok, got ${o.reason}`);
  return o.state;
};
const why = (o: SpyOutcome) => (o.ok ? "ok" : o.reason);

function pool(n = 5): SpyState {
  let st = initialSpyState();
  for (let i = 0; i < n; i++) st = must(applyAddWord(st, P[i % 3]!, `word${i}`, 3));
  return st;
}
const talking = (seed = 1) => must(applyBegin(pool(), P, seed, 5));
function deciding(seed = 1): SpyState {
  let st = talking(seed);
  for (const id of [...st.order]) st = must(applyEndTurn(st, { playerId: id }));
  return st;
}
function everyoneDecides(st: SpyState, choice: "vote" | "continue"): SpyState {
  let cur = st;
  for (const id of cur.order) cur = must(applyDecide(cur, id, choice));
  return cur;
}
const voting = (seed = 1) => settleState(everyoneDecides(deciding(seed), "vote"), []);
function castVotes(st: SpyState, target: (voter: string) => string): SpyState {
  let cur = st;
  for (const id of cur.order) cur = must(applyVote(cur, id, target(id)));
  return cur;
}
/** All non-spies accuse the spy; the spy accuses someone else. */
function lastChance(seed = 1): SpyState {
  const st = voting(seed);
  const first = nonSpyIds(st)[0]!;
  const done = castVotes(st, (v) => (v === st.spyId ? first : st.spyId!));
  return settleState(done, []);
}
function wrongAccusation(seed = 1): SpyState {
  const st = voting(seed);
  const [x, y] = nonSpyIds(st) as [string, string];
  const done = castVotes(st, (v) => (v === x ? y : x));
  return settleState(done, []);
}
const ended = (seed = 1) => must(applyGiveUp(lastChance(seed), lastChance(seed).spyId!));

describe("randomness helpers", () => {
  it("createRng: deterministic, in [0,1)", () => {
    const a = createRng(5);
    const b = createRng(5);
    const xs = Array.from({ length: 10 }, () => a());
    expect(xs).toEqual(Array.from({ length: 10 }, () => b()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
  it("shuffle: a permutation, deterministic, never mutates the input", () => {
    const input = ["a", "b", "c", "d", "e"];
    const out = shuffle(input, createRng(3));
    expect([...out].sort()).toEqual(input);
    expect(shuffle(input, createRng(3))).toEqual(out);
    expect(input).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("pickSeeded: independent of candidate order, depends on seed and salt", () => {
    expect(pickSeeded(["a", "b", "c"], 1, 1)).toBe(pickSeeded(["c", "a", "b"], 1, 1));
    const picks = new Set(Array.from({ length: 30 }, (_, s) => pickSeeded(["a", "b", "c"], s, 1)));
    expect(picks.size).toBeGreaterThan(1);
    expect(pickSeeded(["only"], 9, 9)).toBe("only");
  });
});

describe("cleanWordText", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanWordText("  big   cat ")).toBe("big cat");
  });
  it("rejects empty and too long", () => {
    expect(cleanWordText("   ")).toBeUndefined();
    expect(cleanWordText("x".repeat(MAX_WORD_LENGTH))).toBeDefined();
    expect(cleanWordText("x".repeat(MAX_WORD_LENGTH + 1))).toBeUndefined();
  });
});

describe("words", () => {
  it("adds with ids w1, w2, ... and bumps the counter", () => {
    let st = must(applyAddWord(initialSpyState(), "a", "cat", 3));
    st = must(applyAddWord(st, "b", "dog", 3));
    expect(st.words).toEqual([
      { id: "w1", ownerId: "a", text: "cat" },
      { id: "w2", ownerId: "b", text: "dog" },
    ]);
    expect(st.nextWordId).toBe(3);
  });
  it("invalid, over the limit, duplicate (case-insensitive)", () => {
    const st = must(applyAddWord(initialSpyState(), "a", "Cat", 1));
    expect(why(applyAddWord(st, "a", "  ", 1))).toBe("invalid-word");
    expect(why(applyAddWord(st, "a", "dog", 1))).toBe("word-limit");
    expect(why(applyAddWord(st, "b", "cAt", 1))).toBe("duplicate-word");
  });
  it("only while collecting", () => {
    expect(why(applyAddWord(talking(), "a", "x", 3))).toBe("wrong-phase");
    expect(why(applyAddWord(ended(), "a", "x", 3))).toBe("game-over");
  });
  it("remove: only your own, only existing, only while collecting", () => {
    const st = must(applyAddWord(initialSpyState(), "a", "cat", 3));
    expect(why(applyRemoveWord(st, "a", "w9"))).toBe("unknown-word");
    expect(why(applyRemoveWord(st, "b", "w1"))).toBe("not-your-word");
    expect(must(applyRemoveWord(st, "a", "w1")).words).toEqual([]);
    expect(why(applyRemoveWord(talking(), "a", "w1"))).toBe("wrong-phase");
    expect(why(applyRemoveWord(ended(), "a", "w1"))).toBe("game-over");
  });
});

describe("begin", () => {
  it("needs enough players and words, and the collecting phase", () => {
    expect(why(applyBegin(pool(), ["a", "b"], 1, 5))).toBe("too-few-players");
    expect(why(applyBegin(pool(2), P, 1, 5))).toBe("too-few-words");
    expect(why(applyBegin(talking(), P, 1, 5))).toBe("wrong-phase");
    expect(why(applyBegin(ended(), P, 1, 5))).toBe("game-over");
  });
  it("draws word, spy and order from the seed: deterministic", () => {
    expect(talking(5)).toEqual(talking(5));
    const spies = new Set(Array.from({ length: 30 }, (_, s) => talking(s).spyId));
    expect(spies.size).toBeGreaterThan(1);
  });
  it("for every seed: the spy is a player, the order is a permutation, the first speaker is never the spy", () => {
    for (let seed = 0; seed < 120; seed++) {
      const st = talking(seed);
      expect(P).toContain(st.spyId);
      expect([...st.order].sort()).toEqual(P);
      expect(st.order[0]).not.toBe(st.spyId);
      expect(st.words.map((w) => w.text)).toContain(st.word);
      expect(st).toMatchObject({
        phase: "talking",
        turn: 0,
        circle: 1,
        decisions: {},
        votes: {},
        rngSeed: seed,
      });
    }
  });
});

describe("reading helpers", () => {
  it("currentSpeakerId only while talking; nonSpyIds excludes the spy", () => {
    const st = talking();
    expect(currentSpeakerId(st)).toBe(st.order[0]);
    expect(currentSpeakerId(deciding())).toBeUndefined();
    expect(nonSpyIds(st)).toHaveLength(2);
    expect(nonSpyIds(st)).not.toContain(st.spyId);
  });
});

describe("talking", () => {
  it("only the speaker ends a turn; the host can skip", () => {
    const st = talking();
    expect(why(applyEndTurn(st, { playerId: st.order[1]! }))).toBe("not-your-turn");
    expect(must(applyEndTurn(st, { playerId: st.order[0]! })).turn).toBe(1);
    expect(must(applyEndTurn(st, "host")).turn).toBe(1);
  });
  it("after the last speaker the game moves to deciding with a clean slate", () => {
    const st = deciding();
    expect(st).toMatchObject({ phase: "deciding", turn: 0, decisions: {} });
  });
  it("wrong phase, game over, claim pending", () => {
    expect(why(applyEndTurn(pool(), "host"))).toBe("wrong-phase");
    expect(why(applyEndTurn(ended(), "host"))).toBe("game-over");
    const claimed = must(applyClaimWord(talking(), talking().spyId!));
    expect(why(applyEndTurn(claimed, "host"))).toBe("claim-pending");
  });
});

describe("deciding", () => {
  it("records a choice from a participant, in the deciding phase", () => {
    const st = deciding();
    expect(must(applyDecide(st, "a", "vote")).decisions).toEqual({ a: "vote" });
    expect(why(applyDecide(st, "zz", "vote"))).toBe("not-a-participant");
    expect(why(applyDecide(talking(), "a", "vote"))).toBe("wrong-phase");
    expect(why(applyDecide(ended(), "a", "vote"))).toBe("game-over");
  });
  it("a majority for voting leads to voting, otherwise another circle", () => {
    const yes = settleState(everyoneDecides(deciding(), "vote"), []);
    expect(yes).toMatchObject({ phase: "voting", decisions: {}, votes: {} });
    const no = settleState(everyoneDecides(deciding(), "continue"), []);
    expect(no).toMatchObject({ phase: "talking", circle: 2, turn: 0, decisions: {} });
  });
  it("an exact tie does not carry the vote", () => {
    let st = deciding();
    st = must(applyDecide(st, st.order[0]!, "vote"));
    st = must(applyDecide(st, st.order[1]!, "continue"));
    const forced = must(applyForceAdvance(st));
    expect(forced.phase).toBe("talking");
  });
});

describe("voting", () => {
  it("validates the voter and the target", () => {
    const st = voting();
    expect(why(applyVote(st, "zz", "a"))).toBe("not-a-participant");
    expect(why(applyVote(st, "a", "a"))).toBe("cannot-vote-self");
    expect(why(applyVote(st, "a", "zz"))).toBe("unknown-target");
    expect(why(applyVote(deciding(), "a", "b"))).toBe("wrong-phase");
    expect(must(applyVote(st, "a", "b")).votes).toEqual({ a: "b" });
  });
  it("accusing the spy leads to the last chance", () => {
    const st = lastChance();
    expect(st.phase).toBe("lastChance");
    expect(st.accusedId).toBe(st.spyId);
  });
  it("accusing someone else ends the game: the spy wins", () => {
    expect(wrongAccusation()).toMatchObject({
      phase: "ended",
      result: { winner: "spy", reason: "wrong-accusation" },
    });
  });
  it("forcing a vote with no votes cast is deterministic and ends in a valid outcome", () => {
    const st = voting();
    const a = must(applyForceAdvance(st));
    expect(must(applyForceAdvance(st))).toEqual(a);
    expect(["lastChance", "ended"]).toContain(a.phase);
    expect(P).toContain(a.accusedId);
  });
});

describe("claim", () => {
  const claimed = (st: SpyState) => must(applyClaimWord(st, st.spyId!));

  it("only the spy, only while the game runs, only once", () => {
    const st = talking();
    expect(why(applyClaimWord(st, nonSpyIds(st)[0]!))).toBe("not-the-spy");
    expect(why(applyClaimWord(pool(), "a"))).toBe("wrong-phase");
    expect(why(applyClaimWord(ended(), "a"))).toBe("game-over");
    expect(why(applyClaimWord(claimed(st), st.spyId!))).toBe("claim-pending");
    expect(claimed(st).claim).toEqual({ from: "talking", votes: {} });
    expect(claimed(lastChance()).claim?.from).toBe("lastChance");
  });
  it("only the other players vote on the claim", () => {
    const st = claimed(talking());
    const voter = nonSpyIds(st)[0]!;
    expect(why(applyClaimVote(st, st.spyId!, true))).toBe("not-eligible");
    expect(why(applyClaimVote(st, "zz", true))).toBe("not-eligible");
    expect(why(applyClaimVote(talking(), voter, true))).toBe("no-claim");
    expect(why(applyClaimVote(ended(), voter, true))).toBe("game-over");
    expect(must(applyClaimVote(st, voter, true)).claim?.votes).toEqual({ [voter]: true });
  });
  it("a majority of Correct: the spy wins; `spy-caught-guessed` when already accused", () => {
    const st = claimed(talking());
    const all = nonSpyIds(st).reduce((cur, id) => must(applyClaimVote(cur, id, true)), st);
    expect(must(applyForceAdvance(all)).result).toEqual({ winner: "spy", reason: "spy-guessed" });

    const late = claimed(lastChance());
    const allLate = nonSpyIds(late).reduce((cur, id) => must(applyClaimVote(cur, id, true)), late);
    expect(must(applyForceAdvance(allLate)).result).toEqual({
      winner: "spy",
      reason: "spy-caught-guessed",
    });
  });
  it("a majority of Wrong, or no votes at all: the players win", () => {
    const st = claimed(talking());
    const all = nonSpyIds(st).reduce((cur, id) => must(applyClaimVote(cur, id, false)), st);
    expect(must(applyForceAdvance(all)).result).toEqual({
      winner: "players",
      reason: "spy-failed-guess",
    });
    expect(must(applyForceAdvance(st)).result).toEqual({
      winner: "players",
      reason: "spy-failed-guess",
    });
  });
  it("an exact tie is a seeded coin: deterministic", () => {
    const st = claimed(talking());
    const [x, y] = nonSpyIds(st) as [string, string];
    const tied = must(applyClaimVote(must(applyClaimVote(st, x, true)), y, false));
    const r1 = must(applyForceAdvance(tied));
    expect(must(applyForceAdvance(tied))).toEqual(r1);
    expect(r1.phase).toBe("ended");
  });
  it("a pending claim blocks the normal actions", () => {
    const st = claimed(deciding());
    expect(why(applyDecide(st, "a", "vote"))).toBe("claim-pending");
    expect(why(applyGiveUp(claimed(lastChance()), "a"))).toBe("claim-pending");
  });
});

describe("last chance and host override", () => {
  it("giving up ends the game for the players, only the spy, only in lastChance", () => {
    const st = lastChance();
    expect(why(applyGiveUp(st, nonSpyIds(st)[0]!))).toBe("not-the-spy");
    expect(why(applyGiveUp(voting(), "a"))).toBe("wrong-phase");
    expect(must(applyGiveUp(st, st.spyId!)).result).toEqual({
      winner: "players",
      reason: "spy-caught",
    });
  });
  it("forceAdvance resolves a deciding phase and last chance; refuses elsewhere", () => {
    expect(must(applyForceAdvance(deciding())).phase).toBe("talking"); // nobody decided
    expect(must(applyForceAdvance(lastChance())).result).toEqual({
      winner: "players",
      reason: "spy-caught",
    });
    expect(why(applyForceAdvance(talking()))).toBe("nothing-to-advance");
    expect(why(applyForceAdvance(pool()))).toBe("nothing-to-advance");
    expect(why(applyForceAdvance(ended()))).toBe("game-over");
  });
  it("forcing a deciding phase with a majority for voting goes to voting", () => {
    let st = deciding();
    st = must(applyDecide(st, "a", "vote"));
    expect(must(applyForceAdvance(st)).phase).toBe("voting");
  });
});

describe("settling (away players)", () => {
  it("nothing to settle: the very same object", () => {
    const st = talking();
    expect(settleState(st, [])).toBe(st);
    expect(settleState(st, ["zz"])).toBe(st);
    expect(settleState(ended(), P)).toEqual(ended());
  });
  it("an away speaker is skipped, a chain of them too, the last one leads to deciding", () => {
    const st = talking();
    expect(settleState(st, [st.order[0]!]).turn).toBe(1);
    expect(settleState(st, [st.order[0]!, st.order[1]!]).turn).toBe(2);
    expect(settleState(st, P)).toMatchObject({ phase: "deciding", turn: 0 });
  });
  it("deciding resolves once everyone still here has answered", () => {
    const st = must(applyDecide(deciding(), deciding().order[0]!, "vote"));
    const away = st.order.slice(1);
    expect(settleState(st, away).phase).toBe("voting");
    expect(settleState(st, [away[0]!])).toBe(st); // one still to answer
  });
  it("nobody answered: no resolution, even with everyone away", () => {
    const st = deciding();
    expect(settleState(st, P)).toBe(st);
  });
  it("voting resolves with the votes cast by those still here", () => {
    const st = voting();
    const [x, y] = nonSpyIds(st) as [string, string];
    const voted = must(applyVote(st, x, st.spyId!));
    const settled = settleState(voted, [y, st.spyId!]);
    expect(settled.phase).toBe("lastChance");
  });
  it("a claim resolves when every other player here has voted", () => {
    const st = must(applyClaimWord(talking(), talking().spyId!));
    const [x, y] = nonSpyIds(st) as [string, string];
    const voted = must(applyClaimVote(st, x, true));
    expect(settleState(voted, [y]).phase).toBe("ended");
    expect(settleState(voted, [])).toBe(voted);
  });
  it("settle wraps an outcome: ok is settled, a rejection passes through", () => {
    const st = talking();
    const ok = settle({ ok: true, state: st }, [st.order[0]!]);
    expect(ok.ok && ok.state.turn).toBe(1);
    const bad: SpyOutcome = { ok: false, reason: "wrong-phase" };
    expect(settle(bad, P)).toBe(bad);
  });
});
