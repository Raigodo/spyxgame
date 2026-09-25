import { SignalingPeerId } from "../signaling";
import type { PlayerProfile } from "./types";

type PlayerHandler = (player: PlayerProfile) => void;

export class PlayerDirectory {
  private readonly players = new Map<SignalingPeerId, PlayerProfile>();
  private readonly joinedHandlers = new Set<PlayerHandler>();
  private readonly updatedHandlers = new Set<PlayerHandler>();
  private readonly leftHandlers = new Set<PlayerHandler>();

  upsert(profile: PlayerProfile): void {
    const existed = this.players.has(profile.peerId);
    this.players.set(profile.peerId, profile);

    const handlers = existed ? this.updatedHandlers : this.joinedHandlers;
    for (const handler of handlers) handler(profile);
  }

  // Replaces the whole directory (used when a guest applies a full roster
  // snapshot from the host), diffed against the previous contents so
  // joined/updated/left events still fire correctly for consumers.
  replaceAll(profiles: PlayerProfile[]): void {
    const incomingIds = new Set(profiles.map((p) => p.peerId));

    for (const profile of profiles) {
      this.upsert(profile);
    }

    for (const existing of this.players.values()) {
      if (!incomingIds.has(existing.peerId)) {
        this.remove(existing.peerId);
      }
    }
  }

  remove(peerId: SignalingPeerId): void {
    const profile = this.players.get(peerId);
    if (!profile) return;
    this.players.delete(peerId);
    for (const handler of this.leftHandlers) handler(profile);
  }

  get(peerId: SignalingPeerId): PlayerProfile | undefined {
    return this.players.get(peerId);
  }

  getAll(): PlayerProfile[] {
    return Array.from(this.players.values());
  }

  clear(): void {
    for (const profile of this.players.values()) {
      for (const handler of this.leftHandlers) handler(profile);
    }
    this.players.clear();
  }

  onPlayerJoined(handler: PlayerHandler): () => void {
    this.joinedHandlers.add(handler);
    return () => this.joinedHandlers.delete(handler);
  }

  onPlayerUpdated(handler: PlayerHandler): () => void {
    this.updatedHandlers.add(handler);
    return () => this.updatedHandlers.delete(handler);
  }

  onPlayerLeft(handler: PlayerHandler): () => void {
    this.leftHandlers.add(handler);
    return () => this.leftHandlers.delete(handler);
  }
}
