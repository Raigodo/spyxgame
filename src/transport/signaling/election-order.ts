import type { SignalingPeerId } from "./types";

/** UTF-16 code unit order, the same as Array.sort() without a comparator. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The next host: the smallest live peer id, excluding `excludePeerId`. Peer ids are ULIDs, which
 * sort by creation time, so the peer that has been around longest wins. The local peer always
 * counts as live. Every peer computes the same answer from the same membership snapshot.
 */
export function pickNextHost(
  livePeerIds: readonly SignalingPeerId[],
  localPeerId: SignalingPeerId,
  excludePeerId?: SignalingPeerId
): SignalingPeerId | undefined {
  return Array.from(new Set([localPeerId, ...livePeerIds]))
    .filter((id) => id !== excludePeerId)
    .sort(compareIds)[0];
}

/** Registered candidates for one dead host, restricted to live peers (plus self), in turn order. */
export function orderCandidates(args: {
  registered: readonly SignalingPeerId[];
  livePeerIds: readonly SignalingPeerId[];
  localPeerId: SignalingPeerId;
  deadHostPeerId: SignalingPeerId;
}): SignalingPeerId[] {
  const live = new Set([...args.livePeerIds, args.localPeerId]);
  return args.registered
    .filter((id) => id !== args.deadHostPeerId && live.has(id))
    .sort(compareIds);
}

/** Position 0 elects immediately; each later position waits one more interval for its predecessor. */
export function candidateDelayMs(position: number, positionIntervalMs: number): number {
  return position * positionIntervalMs;
}
