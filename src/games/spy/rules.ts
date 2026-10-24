// Pure rules for the spy game. No ports, no clock, no Math.random: all randomness comes from the
// slot seed (the framework's Entropy port, once per round), so a promoted host resolving a phase gets the same answer.
// Every apply* function returns the same shape a reducer needs: { ok: true, state } or { ok: false, reason }.

export type SpyPhase = "collecting" | "talking" | "deciding" | "voting" | "lastChance" | "ended";
export type SpyWinner = "spy" | "players";
export type SpyReason =
  "spy-guessed" | "spy-caught-guessed" | "spy-failed-guess" | "wrong-accusation" | "spy-caught";
export type SpyChoice = "vote" | "continue";
export type ClaimPhase = Extract<SpyPhase, "talking" | "deciding" | "voting" | "lastChance">;

export interface SpyWord {
  id: string;
  ownerId: string;
  text: string;
}

export interface SpyClaim {
  /** The phase the spy claimed in. Informational: a resolved claim always ends the game. */
  from: ClaimPhase;
  /** playerId -> true when the voter says the spoken word was correct. */
  votes: Record<string, boolean>;
}

export interface SpyResult {
  winner: SpyWinner;
  reason: SpyReason;
}

export interface SpyState {
  phase: SpyPhase;
  words: SpyWord[];
  nextWordId: number;
  /** Set by begin. */
  word?: string;
  spyId?: string;
  /** Every participant, shuffled. The speaker is order[turn]. Empty until begin. */
  order: string[];
  turn: number;
  circle: number;
  decisions: Record<string, SpyChoice>;
  votes: Record<string, string>;
  accusedId?: string;
  claim?: SpyClaim;
  rngSeed: number;
  result?: SpyResult;
}

/** Why a rule refuses. Closed, so the game's `reject` type is exact. */
export type SpyReject =
  | "game-over"
  | "wrong-phase"
  | "claim-pending"
  | "invalid-word"
  | "word-limit"
  | "duplicate-word"
  | "unknown-word"
  | "not-your-word"
  | "too-few-players"
  | "too-few-words"
  | "not-your-turn"
  | "not-a-participant"
  | "cannot-vote-self"
  | "unknown-target"
  | "not-the-spy"
  | "not-eligible"
  | "no-claim"
  | "nothing-to-advance";

export type SpyOutcome = { ok: true; state: SpyState } | { ok: false; reason: SpyReject };

export const MAX_WORD_LENGTH = 40;
export const MIN_SPY_PLAYERS = 3;

const SALT_ACCUSATION = 1;
const SALT_CLAIM = 2;

const ok = (state: SpyState): SpyOutcome => ({ ok: true, state });
const reject = (reason: SpyReject): SpyOutcome => ({ ok: false, reason });

export function initialSpyState(): SpyState {
  return {
    phase: "collecting",
    words: [],
    nextWordId: 1,
    order: [],
    turn: 0,
    circle: 1,
    decisions: {},
    votes: {},
    rngSeed: 0,
  };
}

// ─── Seeded randomness ──────────────────────────────────────────────────────

/** mulberry32: a small, well-spread PRNG. Returns floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Same candidates, seed and salt always give the same pick, whatever order the candidates arrive in. */
export function pickSeeded<T extends string>(
  candidates: readonly T[],
  seed: number,
  salt: number
): T {
  const sorted = [...candidates].sort();
  const rng = createRng((seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  return sorted[Math.floor(rng() * sorted.length)] as T;
}

// ─── Words ──────────────────────────────────────────────────────────────────

/** Trims and collapses inner whitespace. Undefined when empty or too long. */
export function cleanWordText(raw: string): string | undefined {
  const text = raw.trim().replace(/\s+/g, " ");
  return text.length >= 1 && text.length <= MAX_WORD_LENGTH ? text : undefined;
}

const sameWord = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function applyAddWord(
  state: SpyState,
  ownerId: string,
  rawText: string,
  wordsPerPlayer: number
): SpyOutcome {
  if (state.phase !== "collecting")
    return reject(state.phase === "ended" ? "game-over" : "wrong-phase");
  const text = cleanWordText(rawText);
  if (text === undefined) return reject("invalid-word");
  if (state.words.filter((w) => w.ownerId === ownerId).length >= wordsPerPlayer) {
    return reject("word-limit");
  }
  if (state.words.some((w) => sameWord(w.text, text))) return reject("duplicate-word");
  const word: SpyWord = { id: `w${state.nextWordId}`, ownerId, text };
  return ok({ ...state, words: [...state.words, word], nextWordId: state.nextWordId + 1 });
}

export function applyRemoveWord(state: SpyState, ownerId: string, wordId: string): SpyOutcome {
  if (state.phase !== "collecting")
    return reject(state.phase === "ended" ? "game-over" : "wrong-phase");
  const word = state.words.find((w) => w.id === wordId);
  if (!word) return reject("unknown-word");
  if (word.ownerId !== ownerId) return reject("not-your-word");
  return ok({ ...state, words: state.words.filter((w) => w.id !== wordId) });
}

// ─── Begin ──────────────────────────────────────────────────────────────────

/** Picks the word, the spy and the speaking order from the seed. The first speaker is never the spy. */
export function applyBegin(
  state: SpyState,
  participants: readonly string[],
  seed: number,
  minWords: number
): SpyOutcome {
  if (state.phase !== "collecting")
    return reject(state.phase === "ended" ? "game-over" : "wrong-phase");
  if (participants.length < MIN_SPY_PLAYERS) return reject("too-few-players");
  if (state.words.length < minWords) return reject("too-few-words");

  const rng = createRng(seed);
  const word = (state.words[Math.floor(rng() * state.words.length)] as SpyWord).text;
  const spyId = participants[Math.floor(rng() * participants.length)] as string;
  let order = shuffle(participants, rng);
  if (order[0] === spyId) order = [...order.slice(1), spyId]; // rotate the spy to the back

  return ok({
    ...state,
    phase: "talking",
    word,
    spyId,
    order,
    turn: 0,
    circle: 1,
    decisions: {},
    votes: {},
    accusedId: undefined,
    claim: undefined,
    rngSeed: seed >>> 0,
    result: undefined,
  });
}

// ─── Reading helpers (for pages) ────────────────────────────────────────────

export function currentSpeakerId(state: SpyState): string | undefined {
  return state.phase === "talking" ? state.order[state.turn] : undefined;
}

export function nonSpyIds(state: SpyState): string[] {
  return state.order.filter((id) => id !== state.spyId);
}

// ─── Guards ─────────────────────────────────────────────────────────────────

/** Why a phase-bound action cannot run now, or undefined if it can. */
function playBlock(state: SpyState, phase: SpyPhase): SpyReject | undefined {
  if (state.phase === "ended") return "game-over";
  if (state.claim) return "claim-pending";
  if (state.phase !== phase) return "wrong-phase";
  return undefined;
}

const finish = (state: SpyState, winner: SpyWinner, reason: SpyReason): SpyState => ({
  ...state,
  phase: "ended",
  claim: undefined,
  result: { winner, reason },
});

// ─── Talking ────────────────────────────────────────────────────────────────

/** `by` is the speaker's playerId, or "host" for a skip. */
export function applyEndTurn(state: SpyState, by: { playerId: string } | "host"): SpyOutcome {
  const blocked = playBlock(state, "talking");
  if (blocked) return reject(blocked);
  if (by !== "host" && state.order[state.turn] !== by.playerId) return reject("not-your-turn");

  const turn = state.turn + 1;
  if (turn < state.order.length) return ok({ ...state, turn });
  return ok({ ...state, phase: "deciding", turn: 0, decisions: {} });
}

// ─── Deciding ───────────────────────────────────────────────────────────────

/** More than half of the choices cast say "vote": go to voting. Otherwise another circle. */
function resolveDecisions(state: SpyState): SpyState {
  const cast = Object.values(state.decisions);
  const yes = cast.filter((c) => c === "vote").length;
  if (cast.length > 0 && yes * 2 > cast.length) {
    return { ...state, phase: "voting", decisions: {}, votes: {} };
  }
  return { ...state, phase: "talking", circle: state.circle + 1, turn: 0, decisions: {} };
}

export function applyDecide(state: SpyState, playerId: string, choice: SpyChoice): SpyOutcome {
  const blocked = playBlock(state, "deciding");
  if (blocked) return reject(blocked);
  if (!state.order.includes(playerId)) return reject("not-a-participant");

  return ok({ ...state, decisions: { ...state.decisions, [playerId]: choice } });
}

// ─── Voting ─────────────────────────────────────────────────────────────────

/** Plurality of the votes cast, ties (or no votes at all) broken by the seed. */
function resolveVotes(state: SpyState): SpyState {
  const tally = new Map<string, number>();
  for (const target of Object.values(state.votes)) tally.set(target, (tally.get(target) ?? 0) + 1);
  const top = Math.max(0, ...tally.values());
  const leaders =
    top === 0 ? state.order : Array.from(tally, ([id, n]) => (n === top ? id : "")).filter(Boolean);
  const accusedId = pickSeeded(leaders, state.rngSeed, state.circle * 10 + SALT_ACCUSATION);

  const accused: SpyState = { ...state, accusedId };
  return accusedId === state.spyId
    ? { ...accused, phase: "lastChance" }
    : finish(accused, "spy", "wrong-accusation");
}

export function applyVote(state: SpyState, playerId: string, target: string): SpyOutcome {
  const blocked = playBlock(state, "voting");
  if (blocked) return reject(blocked);
  if (!state.order.includes(playerId)) return reject("not-a-participant");
  if (target === playerId) return reject("cannot-vote-self");
  if (!state.order.includes(target)) return reject("unknown-target");

  return ok({ ...state, votes: { ...state.votes, [playerId]: target } });
}

// ─── Claim ("I know the word") ──────────────────────────────────────────────

/** Counts the votes cast: more Correct than half wins for the spy, an exact tie is a seeded coin. */
function resolveClaim(state: SpyState): SpyState {
  const claim = state.claim;
  if (!claim) return state;
  const cast = Object.values(claim.votes);
  const yes = cast.filter(Boolean).length;
  const spyWins =
    cast.length === 0
      ? false
      : yes * 2 === cast.length
        ? pickSeeded(["spy", "players"], state.rngSeed, state.circle * 10 + SALT_CLAIM) === "spy"
        : yes * 2 > cast.length;

  if (!spyWins) return finish(state, "players", "spy-failed-guess");
  return finish(state, "spy", state.accusedId !== undefined ? "spy-caught-guessed" : "spy-guessed");
}

const CLAIM_PHASES: readonly SpyPhase[] = ["talking", "deciding", "voting", "lastChance"];

export function applyClaimWord(state: SpyState, playerId: string): SpyOutcome {
  if (state.phase === "ended") return reject("game-over");
  if (state.claim) return reject("claim-pending");
  if (!CLAIM_PHASES.includes(state.phase)) return reject("wrong-phase");
  if (playerId !== state.spyId) return reject("not-the-spy");
  return ok({ ...state, claim: { from: state.phase as ClaimPhase, votes: {} } });
}

export function applyClaimVote(state: SpyState, playerId: string, correct: boolean): SpyOutcome {
  if (state.phase === "ended") return reject("game-over");
  if (!state.claim) return reject("no-claim");
  if (playerId === state.spyId || !state.order.includes(playerId)) return reject("not-eligible");

  return ok({
    ...state,
    claim: { ...state.claim, votes: { ...state.claim.votes, [playerId]: correct } },
  });
}

// ─── Last chance and host override ──────────────────────────────────────────

export function applyGiveUp(state: SpyState, playerId: string): SpyOutcome {
  const blocked = playBlock(state, "lastChance");
  if (blocked) return reject(blocked);
  if (playerId !== state.spyId) return reject("not-the-spy");
  return ok(finish(state, "players", "spy-caught"));
}

/** Host only (the command's `allow`). Resolves whatever is waiting, using what has been cast so far. */
export function applyForceAdvance(state: SpyState): SpyOutcome {
  if (state.phase === "ended") return reject("game-over");
  if (state.claim) return ok(resolveClaim(state));
  switch (state.phase) {
    case "deciding":
      return ok(resolveDecisions(state));
    case "voting":
      return ok(resolveVotes(state));
    case "lastChance":
      return ok(finish(state, "players", "spy-caught"));
    default:
      return reject("nothing-to-advance");
  }
}

// ─── Settling (away players) ────────────────────────────────────────────────

/** True when someone has answered and every player still here has too. */
function allHereAnswered(
  ids: readonly string[],
  cast: Record<string, unknown>,
  away: readonly string[]
): boolean {
  return Object.keys(cast).length > 0 && ids.every((id) => id in cast || away.includes(id));
}

function settleOnce(state: SpyState, away: readonly string[]): SpyState {
  if (state.phase === "ended") return state;
  if (state.claim) {
    return allHereAnswered(nonSpyIds(state), state.claim.votes, away) ? resolveClaim(state) : state;
  }
  switch (state.phase) {
    case "talking": {
      const speaker = state.order[state.turn];
      if (speaker === undefined || !away.includes(speaker)) return state;
      const turn = state.turn + 1; // an away speaker is skipped, a returning one does not get the turn back
      return turn < state.order.length
        ? { ...state, turn }
        : { ...state, phase: "deciding", turn: 0, decisions: {} };
    }
    case "deciding":
      return allHereAnswered(state.order, state.decisions, away) ? resolveDecisions(state) : state;
    case "voting":
      return allHereAnswered(state.order, state.votes, away) ? resolveVotes(state) : state;
    default:
      return state;
  }
}

/**
 * Applies everything that follows from who is away: skips away speakers and resolves a phase once
 * every player still here has answered. Repeats until stable (a skip can land on another away
 * player). The same state object comes back when nothing changed.
 */
export function settleState(state: SpyState, away: readonly string[]): SpyState {
  let current = state;
  for (let i = 0; i < state.order.length + 4; i++) {
    const next = settleOnce(current, away);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Wraps a rule's outcome so a successful change is settled before it is published. */
export function settle(outcome: SpyOutcome, away: readonly string[]): SpyOutcome {
  return outcome.ok ? ok(settleState(outcome.state, away)) : outcome;
}
