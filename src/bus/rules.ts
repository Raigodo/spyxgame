// Pure decisions of the bus. No clocks, no stores, no transport: inputs in, answer out.

export interface Version {
  epoch: number;
  rev: number;
}

/** Negative: a is older. Zero: identical. Positive: a is newer. */
export function compareVersions(a: Version, b: Version): number {
  return a.epoch - b.epoch || a.rev - b.rev;
}

/** Commands are applied exactly once per (sender, seq): anything at or below the mark is a re-send. */
export function isDuplicateCommand(
  applied: Readonly<Record<string, number>>,
  from: string,
  seq: number
): boolean {
  return seq <= (applied[from] ?? 0);
}

/** During recovery, a copy replaces the best one so far only if it is strictly newer. */
export function shouldReplaceBest(candidate: Version, prior: Version | undefined): boolean {
  return prior === undefined || compareVersions(candidate, prior) > 0;
}

/** Recovery is complete once every expected peer has offered (vacuously true with no peers). */
export function isRecoveryComplete(
  expectedPeerIds: readonly string[],
  offeredBy: ReadonlySet<string>
): boolean {
  return expectedPeerIds.every((id) => offeredBy.has(id));
}

/**
 * Drops `applied` marks of peers that are no longer members (review C5). A departed peer never
 * resends because peer ids are never reused. Returns the same object when nothing was dropped.
 */
export function pruneApplied(
  applied: Readonly<Record<string, number>>,
  memberPeerIds: ReadonlySet<string>
): Readonly<Record<string, number>> {
  const kept: Record<string, number> = {};
  let dropped = false;
  for (const [peer, mark] of Object.entries(applied)) {
    if (memberPeerIds.has(peer)) kept[peer] = mark;
    else dropped = true;
  }
  return dropped ? kept : applied;
}

export type BusSyncState = "lost" | "syncing" | "ready";

export interface SyncInput {
  started: boolean;
  isHost: boolean;
  /** Host side: promotion recovery is running. */
  recovering: boolean;
  /** Guest side: an active link to the current host exists. */
  hostLinkActive: boolean;
  allChannelsSynced: boolean;
}

/** lost: a guest with no active host link. syncing: catching up or recovering. ready: otherwise. */
export function computeSync(input: SyncInput): BusSyncState {
  if (!input.started) return "syncing";
  if (input.isHost) return input.recovering ? "syncing" : "ready";
  if (!input.hostLinkActive) return "lost";
  return input.allChannelsSynced ? "ready" : "syncing";
}

/** A guest keeps asking the host for snapshots while it has a link and is not fully synced. */
export function needsResync(input: SyncInput): boolean {
  return input.started && !input.isHost && input.hostLinkActive && !input.allChannelsSynced;
}

/** Host time (guarantee 8): offset to add to the local clock so the old host's time carries on. */
export function hostClockOffset(asOf: number, localNow: number): number {
  return asOf - localNow;
}

/**
 * Host time after a promotion (guarantee 8): continues from the newest real commit among the
 * offered copies. A copy at epoch 0 never was committed, so it carries no time. `undefined`: no
 * evidence, keep the current offset.
 */
export function continuedOffset(
  copies: Iterable<{ epoch: number; asOf: number }>,
  localNow: number
): number | undefined {
  let newest: number | undefined;
  for (const copy of copies) {
    if (copy.epoch > 0 && (newest === undefined || copy.asOf > newest)) newest = copy.asOf;
  }
  return newest === undefined ? undefined : hostClockOffset(newest, localNow);
}

export interface PeerCandidate<T extends string> {
  peerId: T;
  joinedAt: number;
  active: boolean;
}

/** Which peer a player's data goes to when several peers claim it: an active link first, then the newest. */
export function pickPeer<T extends string>(candidates: readonly PeerCandidate<T>[]): T | undefined {
  let best: PeerCandidate<T> | undefined;
  for (const c of candidates) {
    if (
      !best ||
      (c.active && !best.active) ||
      (c.active === best.active && c.joinedAt > best.joinedAt)
    ) {
      best = c;
    }
  }
  return best?.peerId;
}
