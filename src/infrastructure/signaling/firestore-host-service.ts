import { FirestoreGateway } from "./firestore-gateway";
import { SignalingPeerTracker } from "./signaling-peer-tracker";
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
    private readonly localPeer: SignalingPeer, // ← full object
    private readonly tracker: SignalingPeerTracker,
  ) {}

  get localPeerId(): SignalingPeerId {
    return this.localPeer.peerId;
  }

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
    console.log(`[FirestoreHostService] Writing host: ${short(peerId)}`);
    await this.gateway.writeHostCandidate(this.roomId, peerId);
  }

  async clearHost(): Promise<void> {
    console.log("[FirestoreHostService] Clearing host document");
    await this.gateway.clearHostCandidate(this.roomId);
  }

  async currentHost(): Promise<HostDocument | null> {
    return this.gateway.getHostCandidate(this.roomId);
  }

  // Returns all peers sorted by joinedAt ascending — the host candidate line.
  // Uses local tracker, no Firestore call. Includes local peer in the list.
  getCandidatesInLine(): SignalingPeer[] {
    const allPeers = [
      ...this.tracker.getAll(),
      this.localPeer, // ← local peer must be included
    ];

    return allPeers.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  }

  // Elects next host using local tracker peers — no Firestore fetch.
  async electNextHost(
    excludePeerId?: SignalingPeerId,
  ): Promise<SignalingPeerId | null> {
    console.log("[FirestoreHostService] Electing next host");

    const candidates = this.getCandidatesInLine().filter(
      (p) => p.peerId !== excludePeerId,
    );

    if (candidates.length === 0) {
      console.warn("[FirestoreHostService] No peers available for election");
      return null;
    }

    // Oldest peer in remaining candidates becomes host.
    const nextCandidate = candidates[0];

    console.log(
      `[FirestoreHostService] Writing next host: ${short(nextCandidate.peerId)}`,
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
      return sortedPeers[0] ?? null;
    }

    const currentIndex = sortedPeers.findIndex(
      (p) => p.peerId === currentHost.signalingPeerId,
    );

    if (currentIndex === -1) {
      return sortedPeers[0] ?? null;
    }

    return sortedPeers[currentIndex + 1] ?? null;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
