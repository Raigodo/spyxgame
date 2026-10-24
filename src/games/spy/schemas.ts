// Spy's types and network-input schemas (kernel schemas replace the legacy spy-validation.ts).
// Every command payload, the settings and the replicated state are parsed here; rules stay pure.

import { s, type Schema } from "@/kernel";
import type { GameTypes } from "@/game";
import {
  MAX_WORD_LENGTH,
  type ClaimPhase,
  type SpyChoice,
  type SpyPhase,
  type SpyReason,
  type SpyReject,
  type SpyState,
  type SpyWinner,
} from "./rules";

export type SpySettings = { wordsPerPlayer: number; minWords: number };

export type SpyCommand =
  | { type: "addWord"; text: string }
  | { type: "removeWord"; wordId: string }
  | { type: "begin" }
  | { type: "endTurn" }
  | { type: "skipTurn" }
  | { type: "decide"; choice: SpyChoice }
  | { type: "vote"; target: string }
  | { type: "claimWord" }
  | { type: "claimVote"; correct: boolean }
  | { type: "giveUp" }
  | { type: "forceAdvance" };

/** Spy has no ephemeral events or notices. */
export type SpyTypes = GameTypes & {
  settings: SpySettings;
  state: SpyState;
  command: SpyCommand;
  event: never;
  reject: SpyReject;
  mode: "free-for-all";
};

export const DEFAULT_SETTINGS: SpySettings = { wordsPerPlayer: 3, minWords: 5 };
export const MAX_PLAYERS = 12;

const MAX_WORDS_TOTAL = 500;
const MAX_LIST = 64;
const MAX_ID_LENGTH = 100;
const MAX_SEED = 0xffffffff;
/** Capped before trimming so a huge string is never processed; the rules trim and re-check. */
const MAX_RAW_WORD = 4 * MAX_WORD_LENGTH;
const MAX_PAD_LENGTH = 5000;
const MAX_REMARK_LENGTH = 60;

const PHASES = [
  "collecting",
  "talking",
  "deciding",
  "voting",
  "lastChance",
  "ended",
] as const satisfies readonly SpyPhase[];
const CLAIM_PHASES = [
  "talking",
  "deciding",
  "voting",
  "lastChance",
] as const satisfies readonly ClaimPhase[];
const WINNERS = ["spy", "players"] as const satisfies readonly SpyWinner[];
const REASONS = [
  "spy-guessed",
  "spy-caught-guessed",
  "spy-failed-guess",
  "wrong-accusation",
  "spy-caught",
] as const satisfies readonly SpyReason[];
const CHOICES = ["vote", "continue"] as const satisfies readonly SpyChoice[];

const player = s.id("player");
const bounded = { maxKeys: MAX_LIST, onInvalid: "reject" } as const;

export const settingsSchema: Schema<SpySettings> = s.object({
  wordsPerPlayer: s.int({ min: 1, max: 10 }),
  minWords: s.int({ min: 1, max: 100 }),
});

const wordSchema = s.object({
  id: s.string({ min: 1, max: MAX_ID_LENGTH }),
  ownerId: player,
  text: s.string({ min: 1, max: MAX_WORD_LENGTH }),
});

export const stateSchema: Schema<SpyState> = s.object({
  phase: s.oneOf(PHASES),
  words: s.list(wordSchema, { max: MAX_WORDS_TOTAL, onInvalid: "reject" }),
  nextWordId: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  word: s.optional(s.string({ max: MAX_WORD_LENGTH })),
  spyId: s.optional(player),
  order: s.list(player, { max: MAX_LIST, onInvalid: "reject" }),
  turn: s.int({ min: 0, max: MAX_LIST }),
  circle: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  decisions: s.record(s.oneOf(CHOICES), bounded),
  votes: s.record(player, bounded),
  accusedId: s.optional(player),
  claim: s.optional(
    s.object({ from: s.oneOf(CLAIM_PHASES), votes: s.record(s.boolean(), bounded) })
  ),
  rngSeed: s.int({ min: 0, max: MAX_SEED }),
  result: s.optional(s.object({ winner: s.oneOf(WINNERS), reason: s.oneOf(REASONS) })),
});

export const commandSchemas = {
  addWord: s.object({
    type: s.literal("addWord"),
    text: s.string({ max: MAX_RAW_WORD }),
  }),
  removeWord: s.object({
    type: s.literal("removeWord"),
    wordId: s.string({ min: 1, max: MAX_ID_LENGTH }),
  }),
  begin: s.object({ type: s.literal("begin") }),
  endTurn: s.object({ type: s.literal("endTurn") }),
  skipTurn: s.object({ type: s.literal("skipTurn") }),
  decide: s.object({ type: s.literal("decide"), choice: s.oneOf(CHOICES) }),
  vote: s.object({ type: s.literal("vote"), target: player }),
  claimWord: s.object({ type: s.literal("claimWord") }),
  claimVote: s.object({ type: s.literal("claimVote"), correct: s.boolean() }),
  giveUp: s.object({ type: s.literal("giveUp") }),
  forceAdvance: s.object({ type: s.literal("forceAdvance") }),
} as const;

// ─── The player's private notes (device-only, see notes.ts) ─────────────────

export const MARKS = ["unknown", "suspect", "safe"] as const;

export const notesSchema = s.object({
  pad: s.string({ max: MAX_PAD_LENGTH }),
  marks: s.record(s.oneOf(MARKS), { maxKeys: MAX_LIST, onInvalid: "drop" }),
  remarks: s.record(s.string({ max: MAX_REMARK_LENGTH }), {
    maxKeys: MAX_LIST,
    onInvalid: "drop",
  }),
});

export { MAX_PAD_LENGTH, MAX_REMARK_LENGTH };
