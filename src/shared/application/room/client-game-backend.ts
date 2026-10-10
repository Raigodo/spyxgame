import type { GameBackend, GameRuntime, Slot, SlotValue } from "@/shared/application/game";
import type { CommandResult, EventChannel, StateChannel } from "@/shared/application/messaging";
import { Emitter } from "@/shared/kernel";
import type { RoomState } from "./room-state";

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
}

export interface ClientGameBackendDeps {
  getRoomState(): RoomState | undefined;
  getGame(id: string): GameParts | undefined;
  /** True once the room state has synced at least once. */
  isSynced(): boolean;
  getPlayerId(): string | undefined;
  start(id: string, config: unknown): Promise<CommandResult>;
}

// What GameHandle talks to. Reads the client's live parts through `deps`, so it is safe before
// join and after leave (getters return null, intents resolve as "not joined").
export class ClientGameBackend implements GameBackend {
  private readonly slotEms = new Map<string, Emitter>();
  private readonly eventEms = new Map<string, Emitter<GameEventDelivery>>();

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
}
