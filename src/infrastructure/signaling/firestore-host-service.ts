import { FirestoreGateway } from "./firestore-gateway";
import type { SignalingPeerId, RoomId, SignalingPeer } from "./types";

export interface HostDocument {
  signalingPeerId: SignalingPeerId;
  nominatedAt: Date;
}

type HostChangedHandler = (host: HostDocument | null) => void;

export class FirestoreHostService {
  private readonly hostChangedHandlers = new Set<HostChangedHandler>();
  private unsubscribeFromHost?: () => void;

  constructor(
    private readonly gateway: FirestoreGateway,
    private readonly roomId: RoomId,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    console.log("[FirestoreHostService] Starting");

    this.unsubscribeFromHost = this.gateway.subscribeToHostCandidate(
      this.roomId,
      (host) => {
        console.log(
          `[FirestoreHostService] Host document changed: ${host ? short(host.signalingPeerId) : "null"}`,
        );
        for (const handler of this.hostChangedHandlers) {
          handler(host);
        }
      },
    );
  }

  stop(): void {
    console.log("[FirestoreHostService] Stopping");
    this.unsubscribeFromHost?.();
    this.unsubscribeFromHost = undefined;
    this.hostChangedHandlers.clear();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  onHostChanged(handler: HostChangedHandler): () => void {
    this.hostChangedHandlers.add(handler);
    return () => this.hostChangedHandlers.delete(handler);
  }

  async putNewHost(peerId: SignalingPeerId): Promise<void> {
    console.log(
      `[FirestoreHostService] Writing host candidate: ${short(peerId)}`,
    );
    await this.gateway.writeHostCandidate(this.roomId, peerId);
  }

  async clearHost(): Promise<void> {
    console.log("[FirestoreHostService] Clearing host document");
    await this.gateway.clearHostCandidate(this.roomId);
  }

  async currentHost(): Promise<HostDocument | null> {
    return this.gateway.getHostCandidate(this.roomId);
  }

  // Fetches all peers from Firestore, sorts by joinedAt, and nominates
  // the next peer after the current host. If no host exists, nominates
  // the oldest peer. Writes the result to Firestore.
  async electNextHost(): Promise<SignalingPeerId | null> {
    console.log("[FirestoreHostService] Electing next host");

    const [peers, currentHost] = await Promise.all([
      this.gateway.getSignalingPeers(this.roomId),
      this.gateway.getHostCandidate(this.roomId),
    ]);

    if (peers.length === 0) {
      console.warn("[FirestoreHostService] No peers available for election");
      return null;
    }

    const sorted = [...peers].sort(
      (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
    );

    const nextCandidate = this.pickNextCandidate(sorted, currentHost);

    if (!nextCandidate) {
      console.warn("[FirestoreHostService] No next candidate found");
      return null;
    }

    console.log(
      `[FirestoreHostService] Next host candidate: ${short(nextCandidate.peerId)}`,
    );
    await this.gateway.writeHostCandidate(this.roomId, nextCandidate.peerId);

    return nextCandidate.peerId;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private pickNextCandidate(
    sortedPeers: SignalingPeer[],
    currentHost: HostDocument | null,
  ): SignalingPeer | null {
    if (!currentHost) {
      // No current host — oldest peer is first candidate.
      return sortedPeers[0] ?? null;
    }

    const currentIndex = sortedPeers.findIndex(
      (p) => p.peerId === currentHost.signalingPeerId,
    );

    if (currentIndex === -1) {
      // Current host no longer in peer list — start from oldest.
      return sortedPeers[0] ?? null;
    }

    // Next peer after current host in sorted order.
    return sortedPeers[currentIndex + 1] ?? null;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
