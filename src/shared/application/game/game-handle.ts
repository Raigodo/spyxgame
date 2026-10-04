// application/game/game-handle.ts
// What a game's UI talks to: client.useGame(definition). Callback style like the
// rest of the client. Safe before join and after leave (getters return
// undefined, intents resolve as "not joined").

import type { LobbyMode } from "@/shared/application/lobby";
import type { CommandResult } from "@/shared/application/messaging";
import type { GameDefinition, LobbyContext } from "./game-definition";
import { toLobbyContext, type Slot } from "./game-runtime";

/** Implemented by MultiplayerClient. Erased on purpose: the typing lives in GameHandle. */
export interface GameBackend {
  /** The slot only if it belongs to the room's current round and active game, else null. */
  getSlot(gameId: string): Slot | null;
  getLocalPlayerId(): string | undefined;
  sendCommand(gameId: string, name: string, payload: unknown): Promise<CommandResult>;
  /** Returns false if the data failed validation or the client is not joined. */
  sendEvent(gameId: string, name: string, data: unknown, toPeerId?: string): boolean;
  start(gameId: string, config: unknown): Promise<CommandResult>;
  onSlotChanged(gameId: string, handler: () => void): () => void;
  onEvent(gameId: string, handler: (name: string, data: unknown, from: string) => void): () => void;
}

export type GameRole = "player" | "spectator";

export class GameHandle<C, S, Cmds extends object, Evs extends object, M extends LobbyMode> {
  private ctxSlot: Slot | null = null;
  private ctx?: LobbyContext<M>;

  constructor(
    private readonly game: GameDefinition<C, S, Cmds, Evs, M>,
    private readonly backend: GameBackend
  ) {}

  get id(): string {
    return this.game.id;
  }

  // ─── Getters ──────────────────────────────────────────────────────────────

  /** True once the host has initialized this game's state for the current round. */
  isActive(): boolean {
    return this.backend.getSlot(this.game.id) !== null;
  }

  getState(): S | undefined {
    return this.backend.getSlot(this.game.id)?.state as S | undefined;
  }

  getConfig(): C | undefined {
    return this.backend.getSlot(this.game.id)?.config as C | undefined;
  }

  /** The lobby type the game runs in, typed by the game's declared modes. Stable between changes. */
  getContext(): LobbyContext<M> | undefined {
    const slot = this.backend.getSlot(this.game.id);
    if (!slot) return undefined;
    if (slot !== this.ctxSlot) {
      this.ctxSlot = slot;
      this.ctx = toLobbyContext<M>(slot);
    }
    return this.ctx;
  }

  /** Undefined while the game is not active. Late joiners are spectators unless the game admitted them. */
  getRole(): GameRole | undefined {
    const slot = this.backend.getSlot(this.game.id);
    const playerId = this.backend.getLocalPlayerId();
    if (!slot) return undefined;
    return playerId !== undefined && slot.participants.includes(playerId) ? "player" : "spectator";
  }

  getMyTeam(): string | undefined {
    const slot = this.backend.getSlot(this.game.id);
    const playerId = this.backend.getLocalPlayerId();
    return slot && playerId !== undefined ? slot.teams[playerId] : undefined;
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  onActiveChanged(handler: (active: boolean) => void): () => void {
    let last = this.isActive();
    return this.backend.onSlotChanged(this.game.id, () => {
      const now = this.isActive();
      if (now === last) return;
      last = now;
      handler(now);
    });
  }

  onStateChanged(handler: (state: S, prev: S | undefined) => void): () => void {
    let last = this.backend.getSlot(this.game.id);
    return this.backend.onSlotChanged(this.game.id, () => {
      const slot = this.backend.getSlot(this.game.id);
      const prev = last;
      last = slot;
      if (slot && slot.state !== prev?.state)
        handler(slot.state as S, prev?.state as S | undefined);
    });
  }

  /** Ephemeral game events, validated by the game's own validators before they reach you. */
  onEvent<K extends keyof Evs & string>(
    name: K,
    handler: (data: Evs[K], from: string) => void
  ): () => void {
    return this.backend.onEvent(this.game.id, (eventName, data, from) => {
      if (eventName === name) handler(data as Evs[K], from);
    });
  }

  /** Fires on any change to this game's slot: state, roster, role, active flag. Ideal as a useSyncExternalStore subscription. */
  onChanged(handler: () => void): () => void {
    return this.backend.onSlotChanged(this.game.id, handler);
  }

  // ─── Intents ──────────────────────────────────────────────────────────────

  /** Host-only. The config type is checked against the game definition. */
  start(config: C): Promise<CommandResult> {
    return this.backend.start(this.game.id, config);
  }

  /** Resolves with the host's verdict, e.g. rejected: "not-a-participant". Queued across a host change. */
  sendCommand<K extends keyof Cmds & string>(name: K, payload: Cmds[K]): Promise<CommandResult> {
    return this.backend.sendCommand(this.game.id, name, payload);
  }

  /** Returns false if the data failed the game's validator, so nothing was sent. */
  broadcastEvent<K extends keyof Evs & string>(name: K, data: Evs[K]): boolean {
    return this.backend.sendEvent(this.game.id, name, data);
  }

  sendEvent<K extends keyof Evs & string>(peerId: string, name: K, data: Evs[K]): boolean {
    return this.backend.sendEvent(this.game.id, name, data, peerId);
  }
}
