import { Emitter } from "@/shared/kernel";
import type { SignalingPeerId } from "../signaling";
import type { PlayerProfile } from "./types";

export class PlayerDirectory {
  private readonly players = new Map<SignalingPeerId, PlayerProfile>();
  private readonly joined = new Emitter<PlayerProfile>();
  private readonly updated = new Emitter<PlayerProfile>();
  private readonly left = new Emitter<PlayerProfile>();

  upsert(profile: PlayerProfile): void {
    const existed = this.players.has(profile.peerId);
    this.players.set(profile.peerId, profile);
    (existed ? this.updated : this.joined).emit(profile);
  }

  // Replaces the whole directory (a guest applying the host's roster snapshot), diffed against
  // the previous contents so joined/updated/left still fire correctly. Stale ids are collected
  // up front, so nothing is deleted while iterating.
  replaceAll(profiles: PlayerProfile[]): void {
    const incomingIds = new Set(profiles.map((p) => p.peerId));
    const staleIds = Array.from(this.players.keys()).filter((id) => !incomingIds.has(id));

    for (const profile of profiles) this.upsert(profile);
    for (const id of staleIds) this.remove(id);
  }

  remove(peerId: SignalingPeerId): void {
    const profile = this.players.get(peerId);
    if (!profile) return;
    this.players.delete(peerId);
    this.left.emit(profile);
  }

  get(peerId: SignalingPeerId): PlayerProfile | undefined {
    return this.players.get(peerId);
  }

  getAll(): PlayerProfile[] {
    return Array.from(this.players.values());
  }

  clear(): void {
    const all = this.getAll();
    this.players.clear();
    for (const profile of all) this.left.emit(profile);
  }

  onPlayerJoined(handler: (player: PlayerProfile) => void): () => void {
    return this.joined.on(handler);
  }

  onPlayerUpdated(handler: (player: PlayerProfile) => void): () => void {
    return this.updated.on(handler);
  }

  onPlayerLeft(handler: (player: PlayerProfile) => void): () => void {
    return this.left.on(handler);
  }
}
