import { Emitter } from "@/shared/kernel";
import type { SignalingPeer, SignalingPeerId } from "./types";

export class SignalingPeerTracker {
  private readonly peers = new Map<SignalingPeerId, SignalingPeer>();
  private readonly added: Emitter<SignalingPeer>;
  private readonly removed: Emitter<SignalingPeer>;

  constructor(onError?: (error: unknown) => void) {
    this.added = new Emitter<SignalingPeer>(onError);
    this.removed = new Emitter<SignalingPeer>(onError);
  }

  add(peer: SignalingPeer): void {
    if (this.peers.has(peer.peerId)) {
      throw new Error(`Peer "${peer.peerId}" is already tracked.`);
    }
    this.peers.set(peer.peerId, peer);
    this.added.emit(peer);
  }

  remove(peerId: SignalingPeerId): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer "${peerId}" is not tracked.`);
    }
    this.peers.delete(peerId);
    this.removed.emit(peer);
  }

  update(peer: SignalingPeer): void {
    if (!this.peers.has(peer.peerId)) {
      throw new Error(`Peer "${peer.peerId}" is not tracked.`);
    }
    this.peers.set(peer.peerId, peer);
  }

  get(peerId: SignalingPeerId): SignalingPeer {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer "${peerId}" is not tracked.`);
    }
    return peer;
  }

  has(peerId: SignalingPeerId): boolean {
    return this.peers.has(peerId);
  }

  getAll(): SignalingPeer[] {
    return Array.from(this.peers.values());
  }

  clear(): void {
    // Fire removed handlers for each peer before clearing,
    // so consumers can clean up their side too.
    for (const peer of this.peers.values()) this.removed.emit(peer);
    this.peers.clear();
  }

  onPeerAdded(handler: (peer: SignalingPeer) => void): () => void {
    return this.added.on(handler);
  }
  onPeerRemoved(handler: (peer: SignalingPeer) => void): () => void {
    return this.removed.on(handler);
  }
}
