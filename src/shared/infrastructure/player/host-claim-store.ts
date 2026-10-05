// infrastructure/player/host-claim-store.ts
// "I was host in this room, as peer X." Lets a page refresh take the host seat
// back. sessionStorage on purpose: it survives a refresh of the same tab, and
// is gone for a new tab, another device or a closed tab, which then start as
// ordinary guests.
//
// It is only a hint: the claim itself is verified against Firestore (the host
// document must still name this peer, and that peer must be gone from the room).

const KEY_PREFIX = "host-claim:";

interface HostClaim {
  playerId: string;
  peerId: string;
}

export function rememberHostPeer(roomId: string, playerId: string, peerId: string): void {
  try {
    const claim: HostClaim = { playerId, peerId };
    sessionStorage.setItem(KEY_PREFIX + roomId, JSON.stringify(claim));
  } catch {
    // best-effort: without it a refreshed host just rejoins as a guest
  }
}

/** The peer id this player had as host in this room, or undefined. Keyed by playerId too. */
export function recallHostPeer(roomId: string, playerId: string): string | undefined {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + roomId);
    if (!raw) return undefined;
    const claim = JSON.parse(raw) as Partial<HostClaim>;
    return claim.playerId === playerId && typeof claim.peerId === "string"
      ? claim.peerId
      : undefined;
  } catch {
    return undefined;
  }
}

/** A deliberate leave (or being superseded) must never reclaim. */
export function forgetHostPeer(roomId: string): void {
  try {
    sessionStorage.removeItem(KEY_PREFIX + roomId);
  } catch {
    // ignore
  }
}
