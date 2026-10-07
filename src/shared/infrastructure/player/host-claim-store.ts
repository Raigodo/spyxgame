import type { Clock, KeyValueStore, ProfileConfig } from "@/shared/kernel";
import type { FormerHost } from "../webrtc";

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
  /** Set by markLeaving() on pagehide: this page is going away (refresh or close). */
  leftAt?: number;
}

export interface HostClaimStoreDeps {
  store: KeyValueStore;
  clock: Clock;
  config: ProfileConfig;
}

export class HostClaimStore {
  constructor(private readonly deps: HostClaimStoreDeps) {}

  remember(roomId: string, playerId: string, peerId: string): void {
    const claim: HostClaim = { playerId, peerId };
    this.deps.store.set(KEY_PREFIX + roomId, JSON.stringify(claim));
  }

  /** Stamps the stored claim as "this page is leaving". Harmless if there is none. */
  markLeaving(roomId: string): void {
    const claim = this.read(roomId);
    if (!claim) return;
    this.deps.store.set(
      KEY_PREFIX + roomId,
      JSON.stringify({ ...claim, leftAt: this.deps.clock.now() })
    );
  }

  /** The seat this player held in this room. `confirmedGone` means pagehide fired just before this load. */
  recall(roomId: string, playerId: string): FormerHost | undefined {
    const claim = this.read(roomId);
    if (!claim || claim.playerId !== playerId) return undefined;
    const confirmedGone =
      claim.leftAt !== undefined &&
      this.deps.clock.now() - claim.leftAt <= this.deps.config.hostClaimMaxAgeMs;
    return { peerId: claim.peerId, confirmedGone };
  }

  /** A deliberate leave (or being superseded or kicked) must never reclaim. */
  forget(roomId: string): void {
    this.deps.store.remove(KEY_PREFIX + roomId);
  }

  private read(roomId: string): HostClaim | undefined {
    const raw = this.deps.store.get(KEY_PREFIX + roomId);
    if (!raw) return undefined;
    try {
      const claim = JSON.parse(raw) as Partial<HostClaim>;
      if (typeof claim.playerId !== "string" || typeof claim.peerId !== "string") return undefined;
      return {
        playerId: claim.playerId,
        peerId: claim.peerId,
        leftAt: typeof claim.leftAt === "number" ? claim.leftAt : undefined,
      };
    } catch {
      return undefined;
    }
  }
}
