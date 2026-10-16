// What a game's UI talks to: client.getGame(definition). Callback style like the
// rest of the client. Safe before join and after leave (getters return
// undefined, intents resolve as "not joined").

import type { LobbyMode } from "@/shared/application/lobby";
import type { CommandResult } from "@/shared/application/messaging";
import type { GameDefinition, LobbyContext } from "./game-definition";
import { CONTINUE_COMMAND, toLobbyContext, type Slot } from "./game-runtime";
import { shortId, structurallyEqual } from "@/shared/kernel";
import { LocalHandle } from "./local-handle";
import { LocalStateDef } from "./local-state";

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

  /** This player's local value for the running game round, or undefined (not active, nothing stored). */
  readLocal(gameId: string, id: string): string | undefined;
  /** No-op when the game is not active. Notifies onLocalChanged. */
  writeLocal(gameId: string, id: string, raw: string): void;
  onLocalChanged(gameId: string, id: string, handler: () => void): () => void;
  getPrivate(gameId: string): unknown;
}

export type GameRole = "player" | "spectator";

export interface GamePlayer {
  playerId: string;
  name: string;
  role: GameRole;
  /** A participant who is currently missing. Always false for spectators. */
  away: boolean;
}

/** A running (or, while paused, frozen) timer a reducer started. */
export interface GameTimer {
  id: string;
  name: string;
  payload: unknown;
  /** Epoch ms on the host's clock: use it for a countdown, never for game logic. */
  deadlineAt: number;
  paused: boolean;
  /** Time left while paused. */
  remainingMs?: number;
}

/** A notice a reducer emitted, typed by the game's events. */
export type GameNotice<Evs extends object> = {
  [K in keyof Evs & string]: { seq: number; name: K; data: Evs[K] };
}[keyof Evs & string];

const NO_TIMERS: readonly GameTimer[] = [];

const NO_NOTICES: readonly never[] = [];

const NO_AWAY: readonly string[] = [];

const NO_PLAYERS: readonly GamePlayer[] = [];

export class GameHandle<
  C,
  S,
  Cmds extends object,
  Evs extends object,
  M extends LobbyMode,
  H = unknown,
> {
  private ctxSlot: Slot | null = null;
  private ctx?: LobbyContext<M>;
  private playersSlot: Slot | null = null;
  private players: readonly GamePlayer[] = NO_PLAYERS;
  private awaySlot: Slot | null = null;
  private awayList: readonly string[] = NO_AWAY;
  private noticesSlot: Slot | null = null;
  private noticeList: readonly GameNotice<Evs>[] = NO_NOTICES;
  private timersSlot: Slot | null = null;
  private timerList: readonly GameTimer[] = NO_TIMERS;
  private readonly locals = new Map<string, LocalHandle<unknown>>();

  constructor(
    private readonly game: GameDefinition<C, S, Cmds, Evs, M, H>,
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

  /**
   * This player's own private piece (only they, and the host's machine, ever hold it). Undefined
   * until dealt, while it is being re-sent, or after it was removed. Stable between changes.
   */
  getPrivate(): H | undefined {
    return this.backend.getPrivate(this.game.id) as H | undefined;
  }

  /** Participants, then spectators. Same reference until something in it changes. */
  getPlayers(): readonly GamePlayer[] {
    const slot = this.backend.getSlot(this.game.id);
    if (slot === this.playersSlot) return this.players;
    this.playersSlot = slot;
    const next: readonly GamePlayer[] = slot
      ? [
          ...slot.participants.map((id) => this.toPlayer(slot, id, "player")),
          ...slot.spectators.map((id) => this.toPlayer(slot, id, "spectator")),
        ]
      : NO_PLAYERS;
    if (!structurallyEqual(next, this.players)) this.players = next;
    return this.players;
  }

  /** playerIds of participants currently missing. Same reference until the set changes. */
  getAway(): readonly string[] {
    const slot = this.backend.getSlot(this.game.id);
    if (slot === this.awaySlot) return this.awayList;
    this.awaySlot = slot;
    const next = slot?.away ?? NO_AWAY;
    if (!structurallyEqual(next, this.awayList)) this.awayList = next;
    return this.awayList;
  }

  /** Notices emitted this round, oldest first (newest 50). Same reference until one is added. */
  getNotices(): readonly GameNotice<Evs>[] {
    const slot = this.backend.getSlot(this.game.id);
    if (slot === this.noticesSlot) return this.noticeList;
    this.noticesSlot = slot;
    const next = (slot?.notices ?? NO_NOTICES) as unknown as readonly GameNotice<Evs>[];
    if (!structurallyEqual(next, this.noticeList)) this.noticeList = next;
    return this.noticeList;
  }

  /** Active timers, soonest first. Same reference until one is started, fires, is cancelled or paused. */
  getTimers(): readonly GameTimer[] {
    const slot = this.backend.getSlot(this.game.id);
    if (slot === this.timersSlot) return this.timerList;
    this.timersSlot = slot;
    const next: readonly GameTimer[] = slot
      ? Object.entries(slot.timers)
          .sort(([, a], [, b]) => a.deadlineAt - b.deadlineAt)
          .map(([id, t]) => ({
            id,
            name: t.name,
            payload: t.payload,
            deadlineAt: t.deadlineAt,
            paused: t.frozenMs !== undefined,
            remainingMs: t.frozenMs,
          }))
      : NO_TIMERS;
    if (!structurallyEqual(next, this.timerList)) this.timerList = next;
    return this.timerList;
  }

  /** Device-only state for this game (never sent to anyone). Same handle for the same definition id. */
  local<L>(def: LocalStateDef<L>): LocalHandle<L> {
    let handle = this.locals.get(def.id) as LocalHandle<L> | undefined;
    if (!handle) {
      handle = new LocalHandle(def, this.backend, this.game.id);
      this.locals.set(def.id, handle as LocalHandle<unknown>);
    }
    return handle;
  }

  /** True while too few players are here (belowMin "pause"). Commands other than host ones are rejected. */
  isPaused(): boolean {
    return this.backend.getSlot(this.game.id)?.paused ?? false;
  }

  private toPlayer(slot: Slot, playerId: string, role: GameRole): GamePlayer {
    return {
      playerId,
      name: slot.names[playerId] ?? shortId(playerId),
      role,
      away: role === "player" && slot.away.includes(playerId),
    };
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

  /** Fires on every peer when someone goes away or returns. Show a host banner from this. */
  onAwayChanged(handler: (away: readonly string[], prev: readonly string[]) => void): () => void {
    let last = this.getAway();
    return this.backend.onSlotChanged(this.game.id, () => {
      const now = this.getAway();
      if (now === last) return;
      const prev = last;
      last = now;
      handler(now, prev);
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

  /**
   * Fires on every peer for each notice a reducer emits from now on. Notices from before you
   * subscribed (a refresh, a late join) are not replayed: read them with getNotices().
   */
  onNotice<K extends keyof Evs & string>(
    name: K,
    handler: (data: Evs[K], seq: number) => void
  ): () => void {
    let last: number | undefined = this.backend.getSlot(this.game.id)?.noticeSeq;
    return this.backend.onSlotChanged(this.game.id, () => {
      const slot = this.backend.getSlot(this.game.id);
      if (!slot) {
        last = undefined; // game not active: the next slot we see is a join mid-way or a new round
        return;
      }
      if (last === undefined) {
        last = slot.noticeSeq;
        return;
      }
      if (slot.noticeSeq < last) last = 0; // a new round started
      const from = last;
      last = slot.noticeSeq;
      for (const notice of slot.notices) {
        if (notice.seq > from && notice.name === name) handler(notice.data as Evs[K], notice.seq);
      }
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

  /** Host only. Resumes a paused game; it stays resumed until enough players are back. */
  continueAnyway(): Promise<CommandResult> {
    return this.backend.sendCommand(this.game.id, CONTINUE_COMMAND, {});
  }
}
