import { isInt, isRecord } from "@/shared/kernel";
import type { PrivateView, PrivateWrite, SlotRevisions } from "@/shared/application/messaging";

export type { PrivateView, PrivateWrite };

/** What the host runtime needs from the bus channel. PrivateChannel satisfies it. */
export interface PrivateStore {
  view(slot: SlotRevisions): PrivateView<unknown>;
  commit(writes: readonly PrivateWrite[]): void;
  startRound(round: number): void;
  clear(): void;
  flush(): void;
}

/** For games without private state, or before anything was dealt. */
export const EMPTY_VIEW: PrivateView<never> = { get: () => undefined };

export const MAX_PRIVATE = 200;

interface PrivateSlot {
  round: number;
  participants: string[];
  spectators: string[];
  privateRev: Record<string, number>;
  privateSeq: number;
}

/** Network input: playerId -> revision. Absent (older host): none. */
export function parseRevisions(v: unknown): Record<string, number> | undefined {
  if (v === undefined) return {};
  if (!isRecord(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.length > MAX_PRIVATE) return undefined;
  const revisions: Record<string, number> = {};
  for (const [playerId, rev] of entries) if (isInt(rev) && rev >= 1) revisions[playerId] = rev;
  return revisions;
}

/**
 * Turns a reducer's patches (playerId -> piece, or null to remove) into revision bumps and the
 * writes the channel must commit. Revisions come from one counter per round, so a revision is
 * never reused. Returns the same slot when there is nothing to write.
 */
export function applyPrivate<T extends PrivateSlot>(
  slot: T,
  patches: Readonly<Record<string, unknown>> | undefined,
  validate: ((raw: unknown) => unknown) | undefined
): { ok: true; slot: T; writes: PrivateWrite[] } | { ok: false } {
  const entries = patches ? Object.entries(patches) : [];
  if (entries.length === 0) return { ok: true, slot, writes: [] };
  if (!validate || entries.length > MAX_PRIVATE) return { ok: false };

  let seq = slot.privateSeq;
  const revisions = { ...slot.privateRev };
  const writes: PrivateWrite[] = [];
  for (const [playerId, raw] of entries) {
    if (!slot.participants.includes(playerId) && !slot.spectators.includes(playerId)) {
      return { ok: false };
    }
    if (raw === null) {
      if (revisions[playerId] === undefined) continue;
      delete revisions[playerId];
      writes.push({ playerId, round: slot.round, rev: 0, value: null });
      continue;
    }
    const value = validate(raw);
    if (value === undefined) return { ok: false };
    seq += 1;
    revisions[playerId] = seq;
    writes.push({ playerId, round: slot.round, rev: seq, value });
  }
  if (writes.length === 0) return { ok: true, slot, writes };
  return { ok: true, slot: { ...slot, privateRev: revisions, privateSeq: seq }, writes };
}
