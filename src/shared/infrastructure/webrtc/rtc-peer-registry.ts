import { SignalingPeerId } from "../signaling";
import type { PeerEntry, RtcPeer, RtcPeerStatus } from "./types";

type RtcPeerHandler = (peer: RtcPeer) => void;

type StatusChangedHandler = (status: RtcPeerStatus, signalingPeerId: SignalingPeerId) => void;

export class RtcPeerRegistry {
  private readonly peers = new Map<SignalingPeerId, PeerEntry>();
  private readonly peerJoinedHandlers = new Set<RtcPeerHandler>();
  private readonly peerLeftHandlers = new Set<RtcPeerHandler>();
  private readonly statusChangedHandlers = new Set<StatusChangedHandler>();

  // ─── Query ────────────────────────────────────────────────────────────────

  has(signalingPeerId: SignalingPeerId): boolean {
    return this.peers.has(signalingPeerId);
  }

  get(signalingPeerId: SignalingPeerId): PeerEntry | undefined {
    return this.peers.get(signalingPeerId);
  }

  getAll(): RtcPeer[] {
    return Array.from(this.peers.entries(), ([signalingPeerId, entry]) => ({
      signalingPeerId,
      status: entry.status,
    }));
  }

  entries(): IterableIterator<[SignalingPeerId, PeerEntry]> {
    return this.peers.entries();
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  add(signalingPeerId: SignalingPeerId, entry: PeerEntry): void {
    this.peers.set(signalingPeerId, entry);
    this.notifyJoined(signalingPeerId, entry);
  }

  replace(signalingPeerId: SignalingPeerId, entry: PeerEntry): void {
    this.peers.set(signalingPeerId, entry);
  }

  remove(signalingPeerId: SignalingPeerId): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry) return;
    this.peers.delete(signalingPeerId);
    this.notifyLeft(signalingPeerId, entry);
  }

  onAnyStatusChanged(handler: StatusChangedHandler): () => void {
    this.statusChangedHandlers.add(handler);
    return () => this.statusChangedHandlers.delete(handler);
  }

  setStatus(signalingPeerId: SignalingPeerId, status: RtcPeerStatus): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry || entry.status === status) return;
    console.log(
      `[RtcPeerRegistry] Peer=${short(signalingPeerId)} status: ${entry.status} → ${status}`
    );
    entry.status = status;
    for (const handler of this.statusChangedHandlers) {
      handler(status, signalingPeerId);
    }
  }

  disposeAndRemoveAll(): void {
    for (const [signalingPeerId, entry] of this.peers) {
      this.disposeEntry(entry);
      this.peers.delete(signalingPeerId);
      this.notifyLeft(signalingPeerId, entry);
    }
  }

  disposeEntry(entry: PeerEntry): void {
    entry.connection?.close();
    entry.factory.close();
    entry.connection = null;
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  onPeerJoined(handler: RtcPeerHandler): () => void {
    this.peerJoinedHandlers.add(handler);
    return () => this.peerJoinedHandlers.delete(handler);
  }

  onPeerLeft(handler: RtcPeerHandler): () => void {
    this.peerLeftHandlers.add(handler);
    return () => this.peerLeftHandlers.delete(handler);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private notifyJoined(signalingPeerId: SignalingPeerId, entry: PeerEntry): void {
    for (const handler of this.peerJoinedHandlers) {
      handler({ signalingPeerId, status: entry.status });
    }
  }

  private notifyLeft(signalingPeerId: SignalingPeerId, entry: PeerEntry): void {
    for (const handler of this.peerLeftHandlers) {
      handler({ signalingPeerId, status: entry.status });
    }
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
