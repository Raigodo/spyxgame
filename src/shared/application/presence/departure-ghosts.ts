import type { Cancel, Clock } from "@/shared/kernel";
import type { RosterPlayer } from "./types";

export interface DepartureGhostsDeps {
  clock: Clock;
  graceMs: number;
  /** A ghost's grace period ran out without the player returning. */
  onExpired: (player: RosterPlayer) => void;
}

interface Ghost {
  player: RosterPlayer;
  cancel: Cancel;
}

// Players who just left, kept as "reconnecting" rows until they return, the grace period ends,
// or the host removes them on purpose. Local to each peer; nothing here is replicated.
export class DepartureGhosts {
  private readonly ghosts = new Map<string, Ghost>();
  // Removals the host announced before the departure itself reached us.
  private readonly removedOnPurpose = new Set<string>();

  constructor(private readonly deps: DepartureGhostsDeps) {}

  list(): RosterPlayer[] {
    return Array.from(this.ghosts.values(), (ghost) => ghost.player);
  }

  /** Shows `player` as reconnecting. Replaces any existing ghost for the same playerId. */
  add(playerId: string, player: RosterPlayer): void {
    this.drop(playerId);
    const cancel = this.deps.clock.after(this.deps.graceMs, () => {
      const expired = this.drop(playerId);
      if (expired) this.deps.onExpired(expired);
    });
    this.ghosts.set(playerId, { player, cancel });
  }

  /** Removes the ghost and returns its row, or undefined if there was none. */
  drop(playerId: string): RosterPlayer | undefined {
    const ghost = this.ghosts.get(playerId);
    if (!ghost) return undefined;
    ghost.cancel();
    this.ghosts.delete(playerId);
    return ghost.player;
  }

  findPlayerIdByPeer(peerId: string): string | undefined {
    for (const [playerId, ghost] of this.ghosts) {
      if (ghost.player.peerId === peerId) return playerId;
    }
    return undefined;
  }

  announceRemoval(playerId: string): void {
    this.removedOnPurpose.add(playerId);
  }

  /** True once if the host announced this player's removal. */
  takeRemoval(playerId: string): boolean {
    return this.removedOnPurpose.delete(playerId);
  }

  dispose(): void {
    for (const ghost of this.ghosts.values()) ghost.cancel();
    this.ghosts.clear();
    this.removedOnPurpose.clear();
  }
}
