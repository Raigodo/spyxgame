import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RtcPeerStatus } from "@/shared/infrastructure/webrtc";
import type { PresenceEntry, PresenceMap } from "./presence-events";

// The coordinator's data, no behavior. Host side: link status per peer, which peers are
// returning, and each departed player's metadata by durable playerId. Guest side: the last
// status map the host sent.
export class PresenceBook {
  private readonly statuses = new Map<SignalingPeerId, RtcPeerStatus>();
  private readonly returning = new Set<SignalingPeerId>();
  private remotePresence: PresenceMap = {};

  // ─── Host side ────────────────────────────────────────────────────────────
  has(peerId: SignalingPeerId): boolean {
    return this.statuses.has(peerId);
  }
  statusOf(peerId: SignalingPeerId): RtcPeerStatus | undefined {
    return this.statuses.get(peerId);
  }
  setStatus(peerId: SignalingPeerId, status: RtcPeerStatus): void {
    this.statuses.set(peerId, status);
  }
  markReturning(peerId: SignalingPeerId): void {
    this.returning.add(peerId);
  }
  isReturning(peerId: SignalingPeerId): boolean {
    return this.returning.has(peerId);
  }
  forgetPeer(peerId: SignalingPeerId): void {
    this.statuses.delete(peerId);
    this.returning.delete(peerId);
  }
  /** Lost the host role: drop host-only state (history is kept, as before). */
  clearHostState(): void {
    this.statuses.clear();
    this.returning.clear();
  }
  buildMap(): PresenceMap {
    const presence: PresenceMap = {};
    for (const [peerId, status] of this.statuses) {
      presence[peerId] = { status, returning: this.returning.has(peerId) };
    }
    return presence;
  }

  // ─── Guest side ───────────────────────────────────────────────────────────
  setRemote(presence: PresenceMap): void {
    this.remotePresence = presence;
  }
  remote(peerId: SignalingPeerId): PresenceEntry | undefined {
    return this.remotePresence[peerId];
  }

  dispose(): void {
    this.statuses.clear();
    this.returning.clear();
    this.remotePresence = {};
  }

  inspect(): Record<string, unknown> {
    return {
      hostStatuses: Object.fromEntries(this.statuses),
      returning: Array.from(this.returning),
      remotePresence: this.remotePresence,
    };
  }
}
