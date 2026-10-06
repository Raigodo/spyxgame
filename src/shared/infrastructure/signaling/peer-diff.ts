import type { SignalingPeer, SignalingPeerId } from "./types";

export interface PeerDiff {
  /** In incoming order. `isNew` is false when the peer was already known. */
  upserts: Array<{ peer: SignalingPeer; isNew: boolean }>;
  removed: SignalingPeerId[];
}

/** The local peer is never tracked, so it never appears in the diff. */
export function diffPeers(
  knownPeerIds: readonly SignalingPeerId[],
  incoming: readonly SignalingPeer[],
  localPeerId: SignalingPeerId | undefined
): PeerDiff {
  const known = new Set(knownPeerIds);
  const incomingIds = new Set(incoming.map((p) => p.peerId));

  const upserts = incoming
    .filter((peer) => peer.peerId !== localPeerId)
    .map((peer) => ({ peer, isNew: !known.has(peer.peerId) }));
  const removed = knownPeerIds.filter((id) => !incomingIds.has(id));

  return { upserts, removed };
}
