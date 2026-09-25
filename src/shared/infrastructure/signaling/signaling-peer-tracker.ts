import type { SignalingPeer, SignalingPeerId } from "./types";

type PeerHandler = (peer: SignalingPeer) => void;

export class SignalingPeerTracker {
  private readonly peers = new Map<SignalingPeerId, SignalingPeer>();
  private readonly peerAddedHandlers = new Set<PeerHandler>();
  private readonly peerRemovedHandlers = new Set<PeerHandler>();

  add(peer: SignalingPeer): void {
    if (this.peers.has(peer.peerId)) {
      throw new Error(`Peer "${peer.peerId}" is already tracked.`);
    }
    this.peers.set(peer.peerId, peer);
    for (const handler of this.peerAddedHandlers) {
      handler(peer);
    }
  }

  remove(peerId: SignalingPeerId): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer "${peerId}" is not tracked.`);
    }
    this.peers.delete(peerId);
    for (const handler of this.peerRemovedHandlers) {
      handler(peer);
    }
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
    for (const peer of this.peers.values()) {
      for (const handler of this.peerRemovedHandlers) {
        handler(peer);
      }
    }
    this.peers.clear();
  }

  onPeerAdded(handler: PeerHandler): () => void {
    this.peerAddedHandlers.add(handler);
    return () => this.peerAddedHandlers.delete(handler);
  }

  onPeerRemoved(handler: PeerHandler): () => void {
    this.peerRemovedHandlers.add(handler);
    return () => this.peerRemovedHandlers.delete(handler);
  }
}
