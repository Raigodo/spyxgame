import { Emitter, shortId, type Logger } from "@/shared/kernel";
import type { SignalingPeerId } from "../signaling";
import type { PeerEntry, RtcPeer, RtcPeerStatus } from "./types";

export interface RtcPeerRegistryDeps {
  logger: Logger;
}

export class RtcPeerRegistry {
  private readonly peers = new Map<SignalingPeerId, PeerEntry>();
  private readonly joined = new Emitter<RtcPeer>();
  private readonly left = new Emitter<RtcPeer>();
  private readonly statusChanged = new Emitter<RtcPeer>();

  constructor(private readonly deps: RtcPeerRegistryDeps) {}

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
    this.joined.emit({ signalingPeerId, status: entry.status });
  }

  replace(signalingPeerId: SignalingPeerId, entry: PeerEntry): void {
    this.peers.set(signalingPeerId, entry);
  }

  remove(signalingPeerId: SignalingPeerId): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry) return;
    this.peers.delete(signalingPeerId);
    this.left.emit({ signalingPeerId, status: entry.status });
  }

  // Drops an entry without announcing a departure: the peer is still in the room, we just no
  // longer need a link to it. Removed from the map first, so the "connection died" event that
  // closing fires finds nothing to reconnect.
  discard(signalingPeerId: SignalingPeerId): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry) return;
    this.peers.delete(signalingPeerId);
    this.disposeEntry(entry);
  }

  setStatus(signalingPeerId: SignalingPeerId, status: RtcPeerStatus): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry || entry.status === status) return;
    this.deps.logger.debug(`Peer=${shortId(signalingPeerId)} status: ${entry.status} → ${status}`);
    entry.status = status;
    this.statusChanged.emit({ signalingPeerId, status });
  }

  disposeAndRemoveAll(): void {
    for (const [signalingPeerId, entry] of Array.from(this.peers)) {
      this.peers.delete(signalingPeerId); // first, for the same reason as in discard()
      this.disposeEntry(entry);
      this.left.emit({ signalingPeerId, status: entry.status });
    }
  }

  disposeEntry(entry: PeerEntry): void {
    entry.connection?.close();
    entry.negotiator.close();
    entry.connection = null;
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  onPeerJoined(handler: (peer: RtcPeer) => void): () => void {
    return this.joined.on(handler);
  }

  onPeerLeft(handler: (peer: RtcPeer) => void): () => void {
    return this.left.on(handler);
  }

  onStatusChanged(handler: (peer: RtcPeer) => void): () => void {
    return this.statusChanged.on(handler);
  }
}
