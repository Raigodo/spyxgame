import type { BusStatus } from "./types";

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

export interface BusStatusInput {
  started: boolean;
  isHost: boolean;
  recovering: boolean;
  hostLinkActive: boolean;
  allChannelsSynced: boolean;
}

export function computeBusStatus(input: BusStatusInput): BusStatus {
  if (!input.started) return "syncing";
  if (input.isHost) return input.recovering ? "syncing" : "ready";
  return input.hostLinkActive && input.allChannelsSynced ? "ready" : "syncing";
}
