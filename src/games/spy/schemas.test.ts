import { describe, expect, it } from "vitest";
import { MAX_WORD_LENGTH, initialSpyState } from "./rules";
import {
  DEFAULT_SETTINGS,
  MARKS,
  MAX_PAD_LENGTH,
  MAX_REMARK_LENGTH,
  commandSchemas,
  notesSchema,
  settingsSchema,
  stateSchema,
} from "./schemas";

describe("settingsSchema", () => {
  it("accepts the default and the bounds, rejects the rest", () => {
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(settingsSchema.parse({ wordsPerPlayer: 1, minWords: 1 })).toBeDefined();
    expect(settingsSchema.parse({ wordsPerPlayer: 10, minWords: 100 })).toBeDefined();
    expect(settingsSchema.parse({ wordsPerPlayer: 0, minWords: 5 })).toBeUndefined();
    expect(settingsSchema.parse({ wordsPerPlayer: 11, minWords: 5 })).toBeUndefined();
    expect(settingsSchema.parse({ wordsPerPlayer: 3, minWords: 101 })).toBeUndefined();
    expect(settingsSchema.parse({ wordsPerPlayer: 3 })).toBeUndefined();
  });
});

describe("stateSchema", () => {
  it("accepts the initial state", () => {
    expect(stateSchema.parse(initialSpyState())).toEqual(initialSpyState());
  });
  it("accepts a running game with words, votes and a claim", () => {
    const state = {
      ...initialSpyState(),
      phase: "voting",
      words: [{ id: "w1", ownerId: "a", text: "cat" }],
      nextWordId: 2,
      word: "cat",
      spyId: "a",
      order: ["a", "b", "c"],
      decisions: { a: "vote" },
      votes: { b: "a" },
      claim: { from: "talking", votes: { b: true } },
      result: { winner: "spy", reason: "spy-guessed" },
    };
    expect(stateSchema.parse(state)).toEqual(state);
  });
  it("rejects an unknown phase, a bad choice, a long word and an unknown winner", () => {
    const base = initialSpyState();
    expect(stateSchema.parse({ ...base, phase: "party" })).toBeUndefined();
    expect(stateSchema.parse({ ...base, decisions: { a: "maybe" } })).toBeUndefined();
    const word = { id: "w1", ownerId: "a", text: "x".repeat(MAX_WORD_LENGTH + 1) };
    expect(stateSchema.parse({ ...base, words: [word] })).toBeUndefined();
    expect(
      stateSchema.parse({ ...base, result: { winner: "nobody", reason: "spy-caught" } })
    ).toBeUndefined();
  });
  it("bounds the seed and the claim phase", () => {
    const base = initialSpyState();
    expect(stateSchema.parse({ ...base, rngSeed: 0xffffffff + 1 })).toBeUndefined();
    expect(stateSchema.parse({ ...base, rngSeed: -1 })).toBeUndefined();
    expect(
      stateSchema.parse({ ...base, claim: { from: "collecting", votes: {} } })
    ).toBeUndefined();
  });
});

describe("commandSchemas", () => {
  it("every command accepts its shape and rejects a wrong type", () => {
    const valid: Record<keyof typeof commandSchemas, unknown> = {
      addWord: { type: "addWord", text: "cat" },
      removeWord: { type: "removeWord", wordId: "w1" },
      begin: { type: "begin" },
      endTurn: { type: "endTurn" },
      skipTurn: { type: "skipTurn" },
      decide: { type: "decide", choice: "vote" },
      vote: { type: "vote", target: "p2" },
      claimWord: { type: "claimWord" },
      claimVote: { type: "claimVote", correct: true },
      giveUp: { type: "giveUp" },
      forceAdvance: { type: "forceAdvance" },
    };
    for (const [name, schema] of Object.entries(commandSchemas)) {
      const input = valid[name as keyof typeof commandSchemas];
      expect(schema.parse(input)).toEqual(input);
      expect(schema.parse({ type: "nope" })).toBeUndefined();
    }
  });
  it("addWord caps the raw text before the rules trim it", () => {
    expect(
      commandSchemas.addWord.parse({ type: "addWord", text: "x".repeat(4 * MAX_WORD_LENGTH) })
    ).toBeDefined();
    expect(
      commandSchemas.addWord.parse({ type: "addWord", text: "x".repeat(4 * MAX_WORD_LENGTH + 1) })
    ).toBeUndefined();
  });
  it("payload fields are validated", () => {
    expect(commandSchemas.decide.parse({ type: "decide", choice: "maybe" })).toBeUndefined();
    expect(commandSchemas.vote.parse({ type: "vote", target: "" })).toBeUndefined();
    expect(commandSchemas.claimVote.parse({ type: "claimVote", correct: "yes" })).toBeUndefined();
    expect(commandSchemas.removeWord.parse({ type: "removeWord", wordId: "" })).toBeUndefined();
  });
});

describe("notesSchema", () => {
  const valid = { pad: "hi", marks: { a: "suspect" }, remarks: { a: "shifty" } };
  it("accepts valid notes", () => {
    expect(notesSchema.parse(valid)).toEqual(valid);
    expect(MARKS).toEqual(["unknown", "suspect", "safe"]);
  });
  it("rejects a pad or remark that is too long", () => {
    expect(notesSchema.parse({ ...valid, pad: "x".repeat(MAX_PAD_LENGTH + 1) })).toBeUndefined();
    expect(
      notesSchema.parse({ ...valid, remarks: { a: "x".repeat(MAX_REMARK_LENGTH + 1) } })
    ).toEqual({
      ...valid,
      remarks: {},
    });
  });
  it("drops invalid marks instead of rejecting the notes", () => {
    expect(notesSchema.parse({ ...valid, marks: { a: "suspect", b: "evil" } })?.marks).toEqual({
      a: "suspect",
    });
  });
});
