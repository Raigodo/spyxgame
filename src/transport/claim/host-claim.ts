import type { Clock, KeyValueStore, PeerId, PlayerId, RoomId } from "@/kernel";
import type { FormerHost } from "../link/types";
import { confirmedGone, parseClaim, type StoredClaim } from "./rules";

export interface HostClaimDeps {
  /** Per-tab storage, already prefixed with CLAIM_KEY_PREFIX: the key is the room id. */
  store: KeyValueStore;
  clock: Clock;
  config: { hostClaimMaxAgeMs: number };
}

// "I was host in this room, as peer X." Lets a page refresh take the host seat back. Per-tab
// storage on purpose: it survives a refresh of the same tab and is gone for a new tab or device.
// Only a hint: the claim is verified by the atomic host-document write.
export class HostClaim {
  constructor(private readonly deps: HostClaimDeps) {}

  remember(roomId: RoomId, playerId: PlayerId, peerId: PeerId): void {
    const claim: StoredClaim = { playerId, peerId };
    this.deps.store.set(roomId, JSON.stringify(claim));
  }

  /** Stamps the stored claim as "this page is leaving". Harmless if there is none. */
  markLeaving(roomId: RoomId): void {
    const claim = this.read(roomId);
    if (!claim) return;
    this.deps.store.set(roomId, JSON.stringify({ ...claim, leftAt: this.deps.clock.now() }));
  }

  recall(roomId: RoomId, playerId: PlayerId): FormerHost | undefined {
    const claim = this.read(roomId);
    if (!claim || claim.playerId !== playerId) return undefined;
    return {
      peerId: claim.peerId as PeerId,
      confirmedGone: confirmedGone(
        claim,
        this.deps.clock.now(),
        this.deps.config.hostClaimMaxAgeMs
      ),
    };
  }

  /** A deliberate leave (or being dropped) must never reclaim. */
  forget(roomId: RoomId): void {
    this.deps.store.remove(roomId);
  }

  private read(roomId: RoomId): StoredClaim | undefined {
    return parseClaim(this.deps.store.get(roomId));
  }
}
