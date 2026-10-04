// application/game/game-host-runtime.ts
// Runs only on the host, only when the bus is ready. Idempotent: the client
// calls reconcile() whenever the room state, bus status, host role or roster
// changes, and it does nothing unless something is out of line.
//
// It is also the failover repair: a newly promoted host calls this after
// recovery and creates, resets or completes the slot from the replicated room
// state alone.

import type { StateChannel } from "@/shared/application/messaging";
import type { RoomState } from "@/shared/application/room/room-state";
import type { GameRuntime, SlotValue } from "./game-runtime";

export interface GameHostEntry {
  runtime: GameRuntime;
  channel: StateChannel<SlotValue>;
}

export interface GameHostDeps {
  /** True only when this client is host and the bus finished recovery. */
  isHostReady(): boolean;
  getRoomState(): RoomState;
  getRosterPlayerIds(): string[];
}

export class GameHostRuntime {
  private busy = false;

  constructor(
    private readonly games: ReadonlyMap<string, GameHostEntry>,
    private readonly deps: GameHostDeps
  ) {}

  reconcile(): void {
    if (this.busy || !this.deps.isHostReady()) return;
    this.busy = true; // publishing re-enters through change handlers
    try {
      const room = this.deps.getRoomState();
      for (const { runtime, channel } of this.games.values()) {
        const slot = channel.get();
        const active =
          room.phase === "in-game" && room.game?.id === runtime.id ? room.game : undefined;

        if (!active) {
          if (slot !== null) channel.publish(null); // game ended (or never was this one)
          continue;
        }
        if (!slot || slot.round !== room.round) {
          channel.publish(runtime.createSlot(room.round, active.config, active.context));
          continue;
        }

        let next = slot;
        for (const playerId of this.deps.getRosterPlayerIds()) {
          if (next.participants.includes(playerId) || next.spectators.includes(playerId)) continue;
          next = runtime.lateJoin(next, playerId); // default: spectator, the game may admit
        }
        if (next !== slot) channel.publish(next);
      }
    } catch (error) {
      console.warn("[GameHostRuntime] reconcile failed", error);
    } finally {
      this.busy = false;
    }
  }
}
