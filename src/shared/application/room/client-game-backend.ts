import type { GameBackend, GameRuntime, Slot, SlotValue } from "@/shared/application/game";
import type {
  CommandResult,
  EventChannel,
  StateChannel,
  PrivateChannel,
} from "@/shared/application/messaging";
import { Emitter } from "@/shared/kernel";
import type { RoomState } from "./room-state";
import { LocalStorageDeps } from "../game/local-state";

export const NOT_JOINED: CommandResult = { ok: false, kind: "left", reason: "not joined" };

export interface GameEvent {
  name: string;
  data: unknown;
}

interface GameEventDelivery extends GameEvent {
  from: string;
}

export interface GameParts {
  runtime: GameRuntime;
  channel: StateChannel<SlotValue>;
  events: EventChannel<GameEvent>;
  priv?: PrivateChannel<unknown>;
}

export interface ClientGameBackendDeps {
  getRoomState(): RoomState | undefined;
  getGame(id: string): GameParts | undefined;
  /** True once the room state has synced at least once. */
  isSynced(): boolean;
  getPlayerId(): string | undefined;
  start(id: string, config: unknown): Promise<CommandResult>;
  /** Device storage for games' local state. Without it local state is not stored. */
  local?: LocalStorageDeps;
}

// What GameHandle talks to. Reads the client's live parts through `deps`, so it is safe before
// join and after leave (getters return null, intents resolve as "not joined").
export class ClientGameBackend implements GameBackend {
  private readonly slotEms = new Map<string, Emitter>();
  private readonly eventEms = new Map<string, Emitter<GameEventDelivery>>();
  private readonly localEms = new Map<string, Emitter>();

  constructor(
    private readonly deps: ClientGameBackendDeps,
    private readonly onListenerError?: (error: unknown) => void
  ) {}

  getSlot(id: string): Slot | null {
    const room = this.deps.getRoomState();
    const slot = this.deps.getGame(id)?.channel.get() ?? null;
    const current =
      !!room &&
      this.deps.isSynced() &&
      room.phase === "in-game" &&
      room.game?.id === id &&
      slot?.round === room.round;
    return current ? slot : null;
  }

  getLocalPlayerId(): string | undefined {
    return this.deps.getPlayerId();
  }

  getPrivate(id: string): unknown {
    const slot = this.getSlot(id);
    return slot ? this.deps.getGame(id)?.priv?.getMine(slot) : undefined;
  }

  sendCommand(id: string, name: string, payload: unknown): Promise<CommandResult> {
    return this.deps.getGame(id)?.channel.send(name, payload) ?? Promise.resolve(NOT_JOINED);
  }

  sendEvent(id: string, name: string, data: unknown, toPeerId?: string): boolean {
    const game = this.deps.getGame(id);
    if (!game || game.runtime.validateEvent(name, data) === undefined) return false;
    if (toPeerId === undefined) game.events.broadcast({ name, data });
    else game.events.sendTo(toPeerId, { name, data });
    return true;
  }

  start(id: string, config: unknown): Promise<CommandResult> {
    return this.deps.start(id, config);
  }

  onSlotChanged(id: string, handler: () => void): () => void {
    return this.slotEmitter(id).on(handler);
  }

  onEvent(id: string, handler: (name: string, data: unknown, from: string) => void): () => void {
    return this.eventEmitter(id).on(({ name, data, from }) => handler(name, data, from));
  }

  readLocal(gameId: string, id: string): string | undefined {
    const key = this.localKey(gameId, id);
    return key === undefined ? undefined : this.deps.local?.store.get(key);
  }

  writeLocal(gameId: string, id: string, raw: string): void {
    const key = this.localKey(gameId, id);
    const local = this.deps.local;
    if (key === undefined || !local) return;
    local.store.set(key, raw, { ttlSeconds: local.ttlSeconds });
    this.localEmitter(gameId, id).emit();
  }

  onLocalChanged(gameId: string, id: string, handler: () => void): () => void {
    return this.localEmitter(gameId, id).on(handler);
  }

  // ─── Called by the client ─────────────────────────────────────────────────

  emitSlot(id: string): void {
    this.slotEmitter(id).emit();
  }

  /** The room state changed, so any game's isActive may have flipped. */
  emitAllSlots(): void {
    for (const emitter of this.slotEms.values()) emitter.emit();
  }

  emitEvent(id: string, name: string, data: unknown, from: string): void {
    this.eventEmitter(id).emit({ name, data, from });
  }

  private slotEmitter(id: string): Emitter {
    let emitter = this.slotEms.get(id);
    if (!emitter) this.slotEms.set(id, (emitter = new Emitter(this.onListenerError)));
    return emitter;
  }

  private eventEmitter(id: string): Emitter<GameEventDelivery> {
    let emitter = this.eventEms.get(id);
    if (!emitter) {
      this.eventEms.set(id, (emitter = new Emitter<GameEventDelivery>(this.onListenerError)));
    }
    return emitter;
  }

  // Scoped to room, round and player: a refresh keeps it, a new round starts clean.
  private localKey(gameId: string, id: string): string | undefined {
    const roomId = this.deps.local?.getRoomId();
    const playerId = this.deps.getPlayerId();
    const slot = this.getSlot(gameId);
    if (!roomId || playerId === undefined || !slot) return undefined;
    return `game-local:${gameId}:${id}:${roomId}:${slot.round}:${playerId}`;
  }

  private localEmitter(gameId: string, id: string): Emitter {
    const key = `${gameId}:${id}`;
    let emitter = this.localEms.get(key);
    if (!emitter) this.localEms.set(key, (emitter = new Emitter(this.onListenerError)));
    return emitter;
  }
}
