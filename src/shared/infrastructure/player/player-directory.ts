import { Emitter } from "@/shared/kernel";
import type { SignalingPeerId } from "../signaling";
import type { PlayerProfile } from "./types";
import { findDepartedPlayers } from "./roster-diff";

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

  // Replaces the whole directory (a guest applying the host's roster snapshot), so joined,
  // updated and left still fire correctly for consumers.
  replaceAll(profiles: PlayerProfile[]): void {
    const departed = findDepartedPlayers(this.players.keys(), profiles);
    for (const profile of profiles) this.upsert(profile);
    for (const id of departed) this.remove(id);
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
