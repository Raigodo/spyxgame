// Everything that arrives from the network is parsed here: the config, the replicated state and
// every command payload. Pure functions, no game rules. A parser returns undefined on any doubt.

import { isInt, isRecord } from "@/shared/kernel";
import {
  MAX_WORD_LENGTH,
  type ClaimPhase,
  type SpyChoice,
  type SpyClaim,
  type SpyPhase,
  type SpyReason,
  type SpyResult,
  type SpyState,
  type SpyWinner,
  type SpyWord,
} from "./spy-rules";

export interface SpyConfig {
  wordsPerPlayer: number;
  minWords: number;
}

export const DEFAULT_SPY_CONFIG: SpyConfig = { wordsPerPlayer: 3, minWords: 5 };

const MAX_WORDS_TOTAL = 500;
const MAX_PLAYERS_TOTAL = 64;
const MAX_ID_LENGTH = 100;

const PHASES: readonly SpyPhase[] = [
  "collecting",
  "talking",
  "deciding",
  "voting",
  "lastChance",
  "ended",
];
const CLAIM_PHASES: readonly ClaimPhase[] = ["talking", "deciding", "voting", "lastChance"];
const WINNERS: readonly SpyWinner[] = ["spy", "players"];
const REASONS: readonly SpyReason[] = [
  "spy-guessed",
  "spy-caught-guessed",
  "spy-failed-guess",
  "wrong-accusation",
  "spy-caught",
];
const CHOICES: readonly SpyChoice[] = ["vote", "continue"];

// ─── Small parsers ──────────────────────────────────────────────────────────

const oneOf = <T extends string>(options: readonly T[], v: unknown): T | undefined =>
  options.find((o) => o === v);

const parseId = (v: unknown): string | undefined =>
  typeof v === "string" && v.length >= 1 && v.length <= MAX_ID_LENGTH ? v : undefined;

const parseCount = (v: unknown, min: number, max: number): number | undefined =>
  isInt(v) && v >= min && v <= max ? v : undefined;

/** A field that may be absent but, when present, must be valid. `{ value }` wraps so undefined can mean "invalid". */
function optional<T>(v: unknown, parse: (x: unknown) => T | undefined): { value?: T } | undefined {
  if (v === undefined) return {};
  const parsed = parse(v);
  return parsed === undefined ? undefined : { value: parsed };
}

function parseIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_PLAYERS_TOTAL) return undefined;
  const ids = v.map(parseId);
  return ids.every((id): id is string => id !== undefined) ? ids : undefined;
}

/** Every entry must be valid, otherwise the whole record is rejected. */
function parseRecord<T>(
  v: unknown,
  parse: (x: unknown) => T | undefined
): Record<string, T> | undefined {
  if (!isRecord(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.length > MAX_PLAYERS_TOTAL) return undefined;
  const out: Record<string, T> = {};
  for (const [key, raw] of entries) {
    const parsed = parse(raw);
    if (parseId(key) === undefined || parsed === undefined) return undefined;
    out[key] = parsed;
  }
  return out;
}

const parseBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

// ─── Config ─────────────────────────────────────────────────────────────────

export function validateSpyConfig(raw: unknown): SpyConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const wordsPerPlayer = parseCount(raw.wordsPerPlayer, 1, 10);
  const minWords = parseCount(raw.minWords, 1, 100);
  return wordsPerPlayer === undefined || minWords === undefined
    ? undefined
    : { wordsPerPlayer, minWords };
}

// ─── State ──────────────────────────────────────────────────────────────────

function parseWord(raw: unknown): SpyWord | undefined {
  if (!isRecord(raw)) return undefined;
  const id = parseId(raw.id);
  const ownerId = parseId(raw.ownerId);
  const text = typeof raw.text === "string" ? raw.text : undefined;
  if (id === undefined || ownerId === undefined || text === undefined) return undefined;
  return text.length >= 1 && text.length <= MAX_WORD_LENGTH ? { id, ownerId, text } : undefined;
}

function parseClaim(raw: unknown): SpyClaim | undefined {
  if (!isRecord(raw)) return undefined;
  const from = oneOf(CLAIM_PHASES, raw.from);
  const votes = parseRecord(raw.votes, parseBool);
  return from === undefined || votes === undefined ? undefined : { from, votes };
}

function parseResult(raw: unknown): SpyResult | undefined {
  if (!isRecord(raw)) return undefined;
  const winner = oneOf(WINNERS, raw.winner);
  const reason = oneOf(REASONS, raw.reason);
  return winner === undefined || reason === undefined ? undefined : { winner, reason };
}

export function validateSpyState(raw: unknown): SpyState | undefined {
  if (!isRecord(raw)) return undefined;

  const phase = oneOf(PHASES, raw.phase);
  const nextWordId = parseCount(raw.nextWordId, 1, Number.MAX_SAFE_INTEGER);
  const turn = parseCount(raw.turn, 0, MAX_PLAYERS_TOTAL);
  const circle = parseCount(raw.circle, 1, Number.MAX_SAFE_INTEGER);
  const rngSeed = parseCount(raw.rngSeed, 0, 0xffffffff);
  const order = parseIdList(raw.order);
  const decisions = parseRecord(raw.decisions, (v) => oneOf(CHOICES, v));
  const votes = parseRecord(raw.votes, parseId);
  if (!Array.isArray(raw.words) || raw.words.length > MAX_WORDS_TOTAL) return undefined;
  const words = raw.words.map(parseWord);

  const word = optional(raw.word, (v) =>
    typeof v === "string" && v.length <= MAX_WORD_LENGTH ? v : undefined
  );
  const spyId = optional(raw.spyId, parseId);
  const accusedId = optional(raw.accusedId, parseId);
  const claim = optional(raw.claim, parseClaim);
  const result = optional(raw.result, parseResult);

  if (
    phase === undefined ||
    nextWordId === undefined ||
    turn === undefined ||
    circle === undefined ||
    rngSeed === undefined ||
    order === undefined ||
    decisions === undefined ||
    votes === undefined ||
    !words.every((w): w is SpyWord => w !== undefined) ||
    word === undefined ||
    spyId === undefined ||
    accusedId === undefined ||
    claim === undefined ||
    result === undefined
  ) {
    return undefined;
  }

  return {
    phase,
    words,
    nextWordId,
    word: word.value,
    spyId: spyId.value,
    order,
    turn,
    circle,
    decisions,
    votes,
    accusedId: accusedId.value,
    claim: claim.value,
    rngSeed,
    result: result.value,
  };
}

// ─── Command payloads ───────────────────────────────────────────────────────

export type SpyCommands = {
  addWord: { text: string };
  removeWord: { wordId: string };
  begin: { seed: number };
  endTurn: Record<string, never>;
  skipTurn: Record<string, never>;
  decide: { choice: SpyChoice };
  vote: { target: string };
  claimWord: Record<string, never>;
  claimVote: { correct: boolean };
  giveUp: Record<string, never>;
  forceAdvance: Record<string, never>;
};

export const parseNoPayload = (): Record<string, never> => ({});

export function parseAddWord(raw: unknown): SpyCommands["addWord"] | undefined {
  // Length is capped before trimming so a huge string is never processed. The rules trim and re-check.
  return isRecord(raw) && typeof raw.text === "string" && raw.text.length <= 4 * MAX_WORD_LENGTH
    ? { text: raw.text }
    : undefined;
}

export function parseRemoveWord(raw: unknown): SpyCommands["removeWord"] | undefined {
  const wordId = isRecord(raw) ? parseId(raw.wordId) : undefined;
  return wordId === undefined ? undefined : { wordId };
}

export function parseBegin(raw: unknown): SpyCommands["begin"] | undefined {
  const seed = isRecord(raw) ? parseCount(raw.seed, 0, 0xffffffff) : undefined;
  return seed === undefined ? undefined : { seed };
}

export function parseDecide(raw: unknown): SpyCommands["decide"] | undefined {
  const choice = isRecord(raw) ? oneOf(CHOICES, raw.choice) : undefined;
  return choice === undefined ? undefined : { choice };
}

export function parseVote(raw: unknown): SpyCommands["vote"] | undefined {
  const target = isRecord(raw) ? parseId(raw.target) : undefined;
  return target === undefined ? undefined : { target };
}

export function parseClaimVote(raw: unknown): SpyCommands["claimVote"] | undefined {
  const correct = isRecord(raw) ? parseBool(raw.correct) : undefined;
  return correct === undefined ? undefined : { correct };
}
