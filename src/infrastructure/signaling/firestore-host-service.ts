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
    private readonly localPeer: SignalingPeer,
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

  // Registers this peer as a replacement candidate for `deadHostPeerId`.
  async registerAsElectionCandidate(
    deadHostPeerId: SignalingPeerId,
  ): Promise<void> {
    console.log(
      `[FirestoreHostService] Registering candidacy for dead host=${short(deadHostPeerId)}`,
    );
    await this.gateway.registerElectionCandidate(
      this.roomId,
      this.localPeerId,
      deadHostPeerId,
    );
  }

  async removeElectionCandidate(): Promise<void> {
    await this.gateway.deleteElectionCandidate(this.roomId, this.localPeerId);
  }

  // Every candidate that registered for this specific dead host AND is
  // still a live signaling peer, right now — sorted deterministically
  // (lexicographically) so any client calling this around the same time
  // computes the identical order. Both underlying reads are one-shot
  // Firestore fetches, not the locally-cached tracker: the tracker updates
  // at different times per client, which is what made the old ordering
  // diverge between peers and never converge.
  async getOrderedElectionCandidates(
    deadHostPeerId: SignalingPeerId,
  ): Promise<SignalingPeerId[]> {
    const [candidateIds, livePeers] = await Promise.all([
      this.gateway.getElectionCandidates(this.roomId, deadHostPeerId),
      this.gateway.getSignalingPeers(this.roomId),
    ]);

    const liveIds = new Set(livePeers.map((p) => p.peerId));
    liveIds.add(this.localPeerId);

    return candidateIds
      .filter((id) => id !== deadHostPeerId && liveIds.has(id))
      .sort();
  }

  // Elects a host from the currently live signaling peers, deterministically
  // (lexicographic order), excluding `excludePeerId`. Used both for a fresh
  // room's first host and for re-election after a confirmed death.
  async electNextHost(
    excludePeerId?: SignalingPeerId,
  ): Promise<SignalingPeerId | null> {
    console.log("[FirestoreHostService] Electing next host");

    const livePeers = await this.gateway.getSignalingPeers(this.roomId);
    const candidateIds = Array.from(
      new Set([this.localPeerId, ...livePeers.map((p) => p.peerId)]),
    )
      .filter((id) => id !== excludePeerId)
      .sort();

    if (candidateIds.length === 0) {
      console.warn("[FirestoreHostService] No peers available for election");
      return null;
    }

    const nextPeerId = candidateIds[0];
    console.log(
      `[FirestoreHostService] Writing next host: ${short(nextPeerId)}`,
    );
    await this.gateway.writeHostCandidate(this.roomId, nextPeerId);
    return nextPeerId;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
