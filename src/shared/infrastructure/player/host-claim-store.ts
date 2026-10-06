import type { KeyValueStore } from "@/shared/kernel";

// "I was host in this room, as peer X." Lets a page refresh take the host seat back. Backed by
// per-tab storage on purpose: it survives a refresh of the same tab and is gone for a new tab,
// another device or a closed tab, which then start as ordinary guests.
//
// Only a hint: the claim itself is verified against Firestore (the host document must still
// name this peer, and that peer must be gone from the room).

const KEY_PREFIX = "host-claim:";

interface HostClaim {
  playerId: string;
  peerId: string;
}

export interface HostClaimStoreDeps {
  store: KeyValueStore;
}

export class HostClaimStore {
  constructor(private readonly deps: HostClaimStoreDeps) {}

  remember(roomId: string, playerId: string, peerId: string): void {
    const claim: HostClaim = { playerId, peerId };
    this.deps.store.set(KEY_PREFIX + roomId, JSON.stringify(claim));
  }

  /** The peer id this player had as host in this room, or undefined. Keyed by playerId too. */
  recall(roomId: string, playerId: string): string | undefined {
    const raw = this.deps.store.get(KEY_PREFIX + roomId);
    if (!raw) return undefined;
    try {
      const claim = JSON.parse(raw) as Partial<HostClaim>;
      return claim.playerId === playerId && typeof claim.peerId === "string"
        ? claim.peerId
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** A deliberate leave (or being superseded or kicked) must never reclaim. */
  forget(roomId: string): void {
    this.deps.store.remove(KEY_PREFIX + roomId);
  }
}
