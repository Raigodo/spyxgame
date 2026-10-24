// Slot feature `private`: which revision of each player's private piece the slot refers to. The
// pieces themselves never enter the slot; they ride the commit as `privateWrites` (zoom-3), and a
// piece is shown only if its round and revision match. Revisions come from one counter per round,
// so a revision is never reused. Ported from legacy game-private.ts (applyPrivate, parseRevisions).

import type { PrivateWrite } from "@/bus";
import { fail, isRecord, ok, s, type PlayerId, type Result } from "@/kernel";
import type { GameState, ObserveResult, Slot, SlotEnv, SlotFeature } from "../model";
import { MAX_INT32, SLOT_KEY } from "../names";

export type PrivateX = {
  /** playerId -> revision of that player's current piece. */
  rev: Record<string, number>;
  /** Last revision handed out this round. */
  seq: number;
};

const INITIAL: PrivateX = { rev: {}, seq: 0 };

export const privateOf = (slot: Slot): PrivateX =>
  (slot.x[SLOT_KEY.private] as PrivateX | undefined) ?? INITIAL;

/** `PrivateDef.revisions` for the `game` channel. Defensive: it also sees opaque (unknown-game) slots. */
export function revisions(
  state: GameState
): { round: number; rev: Readonly<Record<PlayerId, number>> } | undefined {
  if (!state.slot) return undefined;
  const x: unknown = state.slot.x[SLOT_KEY.private];
  const rev = isRecord(x) && isRecord(x.rev) ? (x.rev as Record<PlayerId, number>) : {};
  return { round: state.round, rev };
}

/**
 * Turns a reducer's patches (playerId -> piece, or null to remove) into revision bumps and the
 * writes to commit with the slot. Returns the same slot when there is nothing to write.
 */
export function applyPrivatePatches(
  slot: Slot,
  patches: Readonly<Record<string, unknown>> | undefined,
  env: SlotEnv
): Result<{ slot: Slot; writes: PrivateWrite[] }, "invalid-private"> {
  const entries = patches ? Object.entries(patches) : [];
  if (entries.length === 0) return ok({ slot, writes: [] });
  if (entries.length > env.config.maxSlotPlayers) return fail("invalid-private");

  const current = privateOf(slot);
  const known = new Set<string>([...slot.setup.participants, ...slot.setup.spectators]);
  const rev = { ...current.rev };
  const writes: PrivateWrite[] = [];
  let seq = current.seq;
  for (const [id, raw] of entries) {
    if (!known.has(id)) return fail("invalid-private");
    const playerId = id as PlayerId;
    if (raw === null) {
      if (rev[id] === undefined) continue;
      delete rev[id];
      writes.push({ playerId, round: env.round, rev: 0, value: null });
      continue;
    }
    const piece = env.runtime.parsePrivate(raw);
    if (!piece) return fail("invalid-private");
    seq += 1;
    rev[id] = seq;
    writes.push({ playerId, round: env.round, rev: seq, value: piece.value });
  }
  if (writes.length === 0) return ok({ slot, writes });
  const x: PrivateX = { rev, seq };
  return ok({ slot: { ...slot, x: { ...slot.x, [SLOT_KEY.private]: x } }, writes });
}

/** Rebuilds pieces the host lost (failover, host refresh) through the game's `recover`. */
function observe(slot: Slot, _observation: unknown, env: SlotEnv): ObserveResult {
  const x = privateOf(slot);
  const patches: Record<string, unknown> = {};
  for (const playerId of slot.setup.participants) {
    if (x.rev[playerId] === undefined) continue; // never had a piece
    if (env.private.get(playerId) !== undefined) continue; // the host holds it
    const piece = env.runtime.recoverPrivate(slot, playerId);
    if (piece !== undefined) patches[playerId] = piece;
  }
  return Object.keys(patches).length === 0 ? { slot } : { slot, private: patches };
}

export const privatePieces: SlotFeature<PrivateX> = {
  key: SLOT_KEY.private,
  initial: () => INITIAL,
  parse(raw, _setup, env) {
    if (raw === undefined) return INITIAL;
    const parsed = s
      .object({
        rev: s.record(s.int({ min: 1, max: MAX_INT32 }), {
          maxKeys: env.config.maxSlotPlayers,
          onInvalid: "drop",
        }),
        seq: s.int({ min: 0, max: MAX_INT32 }),
      })
      .parse(raw);
    if (!parsed) return undefined;
    return { rev: parsed.rev, seq: Math.max(parsed.seq, ...Object.values(parsed.rev)) };
  },
  observe,
};
