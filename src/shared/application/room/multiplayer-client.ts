// Composition root + facade. Exposes plain getters and `on…` callbacks only; no inner class
// (session, presence, bus, lobby) ever leaves this file. Getters are safe to call in any state
// and return referentially stable values between changes, so they can back a
// useSyncExternalStore directly.

import type { PlayerSession, PlayerStores } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { PlayerPresenceService } from "@/shared/application/presence";
import { ChatSendResult, ChatService, type ChatLine } from "@/shared/application/chat";
import {
  buildLocalProfileInput,
  LobbyModule,
  type LobbyMode,
  type LobbyPlayer,
} from "@/shared/application/lobby";
import {
  RoomBus,
  createSessionTransport,
  type CommandResult,
} from "@/shared/application/messaging";
import {
  Emitter,
  PageLifecycle,
  isRecord,
  listenerFailure,
  logFailure,
  type AppConfig,
  type Clock,
  type IdGenerator,
  type Logger,
} from "@/shared/kernel";
import { RoomStateService, type RoomStateOptions } from "./room-state-service";
import type { ActiveGame, GameContext, RoomPhase, RoomState } from "./room-state";
import {
  GameHandle,
  GameHostRuntime,
  type GameDefinition,
  type RegisteredGame,
  type SlotValue,
} from "@/shared/application/game";
import {
  ClientGameBackend,
  NOT_JOINED,
  type GameEvent,
  type GameParts,
} from "./client-game-backend";
import { ClientLifecycle, type ClientStatus } from "./client-lifecycle";
import { HostSeatKeeper, type SeatSource } from "./host-seat-keeper";
import { RosterView, type LobbyInfo } from "./roster-view";

export type { ClientStatus, LobbyInfo };

export interface JoinOptions {
  roomId: string;
  /** Durable id, e.g. from the page URL. Omit for a new player; one is generated. */
  playerId?: string;
  /** Falls back to the stored profile's nickname, then "Player". */
  nickname?: string;
}

export interface JoinResult {
  playerId: string;
  /** True when no playerId was supplied and a new one was minted. */
  generated: boolean;
}

export interface ClientOptions {
  /** Every game the client can run. Registered before the bus starts. */
  games?: readonly RegisteredGame[];
}

/** Everything the client needs from outside. Built by createMultiplayerClient(). */
export interface ClientDeps {
  /** A fresh session stack per join: peerIds must never be reused. */
  createSession(peerId: string): PlayerSession;
  stores: PlayerStores;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
  config: AppConfig;
  pageLifecycle: PageLifecycle;
}

interface Parts {
  session: PlayerSession;
  presence: PlayerPresenceService;
  bus: RoomBus;
  roomState: RoomStateService;
  lobby: LobbyModule;
  cleanups: Array<() => void>;
  chat: ChatService;
  games: Map<string, GameParts>;
  hostRuntime: GameHostRuntime;
}

const EMPTY_CHAT: readonly ChatLine[] = [];

const seatSource = (session: PlayerSession): SeatSource => ({
  isHost: () => session.isHost(),
  getLocalPeerId: () => session.getLocalPlayer()?.peerId,
});

export class MultiplayerClient {
  private parts?: Parts;
  private roomId?: string;
  private playerId?: string;

  private readonly onListenerError = listenerFailure(() => this.deps.logger);
  private readonly roster = new RosterView(this.onListenerError);
  private readonly lifecycle = new ClientLifecycle({
    getBusStatus: () => this.parts?.bus.getStatus(),
    getRoomPhase: () => this.parts?.roomState.getState().phase,
    onListenerError: this.onListenerError,
  });

  private inFlightJoin?: Promise<unknown>;
  private teardownPromise?: Promise<void>;
  private lastSavedNickname?: string;

  private readonly hostEm = new Emitter<SignalingPeerId | undefined>(this.onListenerError);
  private readonly playerIdEm = new Emitter<JoinResult>(this.onListenerError);
  private readonly supersededEm = new Emitter(this.onListenerError);
  private readonly kickedEm = new Emitter(this.onListenerError);
  private readonly joinedEm = new Emitter<LobbyPlayer>(this.onListenerError);
  private readonly rejoinedEm = new Emitter<LobbyPlayer>(this.onListenerError);
  private readonly updatedEm = new Emitter<LobbyPlayer>(this.onListenerError);
  private readonly leftEm = new Emitter<LobbyPlayer>(this.onListenerError);
  private readonly gameEm = new Emitter<ActiveGame | undefined>(this.onListenerError);
  private readonly chatEm = new Emitter<ChatLine>(this.onListenerError);

  private readonly registry = new Map<string, RegisteredGame>();
  private readonly handles = new Map<string, object>();
  private readonly roomOptions: RoomStateOptions;
  private readonly seat: HostSeatKeeper;

  constructor(
    options: ClientOptions,
    private readonly deps: ClientDeps
  ) {
    for (const game of options.games ?? []) {
      if (this.registry.has(game.id))
        throw new Error(`[MultiplayerClient] Duplicate game "${game.id}".`);
      this.registry.set(game.id, game);
    }
    this.seat = new HostSeatKeeper(deps.stores.hostClaims, deps.pageLifecycle);
    this.roomOptions = {
      validateGame: (id, config, context) => {
        const game = this.registry.get(id);
        return game
          ? game.runtime.checkStart(config, context.lobby, context.participants.length)
          : "unknown-game";
      },
    };
  }

  private get stores(): PlayerStores {
    return this.deps.stores;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async join(options: JoinOptions): Promise<JoinResult> {
    if (this.lifecycle.get() !== "idle") {
      throw new Error(
        `[MultiplayerClient] Cannot join while ${this.lifecycle.get()}. Call leave() first.`
      );
    }
    const attempt = this.performJoin(options); // sets lifecycle synchronously
    this.inFlightJoin = attempt.catch(() => undefined);
    return attempt;
  }

  /** Idempotent. Safe to call after a failed join, during a join, or twice. */
  async leave(): Promise<void> {
    await this.inFlightJoin; // let a pending join settle, then tear it down properly
    if (this.roomId) this.seat.forget(this.roomId); // a deliberate leave never reclaims
    await this.teardown();
    this.lifecycle.set("idle");
    this.roomId = undefined;
    this.lifecycle.sync();
  }

  private async performJoin(options: JoinOptions): Promise<JoinResult> {
    this.lifecycle.set("joining");
    this.roomId = options.roomId;
    this.lifecycle.sync();

    const suppliedId = options.playerId?.trim();
    const playerId = suppliedId || this.deps.ids.next();
    const result: JoinResult = { playerId, generated: !suppliedId };
    const nickname =
      options.nickname?.trim() || this.stores.profiles.load(playerId)?.nickname || "Player";

    // A fresh peerId per join, minted here so loggers can be scoped to it. Never reused.
    const peerId = this.deps.ids.next();
    const session = this.deps.createSession(peerId);

    // A room creator's host event fires during join(), before wire() subscribes, and the local
    // profile does not exist yet, so this watcher uses the peerId minted above.
    const offSeatWatch = session.onHostChanged(() =>
      this.seat.remember(options.roomId, playerId, {
        isHost: () => session.isHost(),
        getLocalPeerId: () => peerId,
      })
    );

    let parts: Parts | undefined;
    try {
      await session.join(options.roomId, buildLocalProfileInput(playerId, nickname), {
        peerId,
        formerHost: this.seat.recall(options.roomId, playerId),
      });

      parts = this.assemble(session);
      this.parts = parts; // before start(): handlers fired by start() already see it
      this.wire(parts, playerId, nickname);
      parts.bus.start();
      offSeatWatch(); // wire() now covers every later host change
    } catch (error) {
      offSeatWatch();
      this.parts = undefined;
      if (parts) this.disposeParts(parts);
      await session.leave().catch(logFailure(this.deps.logger, "leave after failed join"));
      this.lifecycle.set("idle");
      this.lifecycle.sync();
      throw error;
    }

    this.playerId = playerId;
    this.lifecycle.set("joined");
    this.refreshPlayers();
    this.refreshPending();
    this.playerIdEm.emit(result); // before callers can see status "ready"
    this.lifecycle.sync();
    return result;
  }

  private assemble(session: PlayerSession): Parts {
    const { clock, ids, logger, config } = this.deps;
    const bus = new RoomBus({
      transport: createSessionTransport(session),
      clock,
      ids,
      logger: logger.child("bus"),
      config: config.bus,
    });
    const presence = new PlayerPresenceService({
      session,
      bus,
      clock,
      ids,
      logger: logger.child("presence"),
      config: config.presence,
    });
    const roomState = new RoomStateService(bus, this.roomOptions);
    const lobby = new LobbyModule(
      presence,
      () => roomState.getState().round,
      roomState.getState().lobby
    );
    const chat = new ChatService({
      bus,
      clock,
      ids,
      config: config.chat,
      getLocalPeerId: () => session.getLocalPlayer()?.peerId,
      resolveSender: (peerId) => {
        const p = presence.getPlayers().find((x) => x.peerId === peerId);
        return p && { playerId: p.playerId, nickname: p.nickname };
      },
      isReady: () => bus.getStatus() === "ready",
    });

    // One state channel (and one event channel) per registered game, all before bus.start().
    const games = new Map<string, GameParts>();
    for (const { id, runtime } of this.registry.values()) {
      const channel = bus.stateChannel<SlotValue>({
        id: `game:${id}`,
        initial: null,
        validate: (raw) => runtime.validateSlot(raw),
        resolveSender: (peerId) => presence.getPlayers().find((p) => p.peerId === peerId)?.playerId,
      });
      runtime.installCommands(channel);
      const events = bus.eventChannel<GameEvent>({
        id: `game:${id}:events`,
        validate: (raw) => {
          if (!isRecord(raw)) return undefined;
          const { name, data } = raw;
          if (typeof name !== "string") return undefined;
          const valid = runtime.validateEvent(name, data);
          return valid === undefined ? undefined : { name, data: valid };
        },
      });
      games.set(id, { runtime, channel, events });
    }

    const hostRuntime = new GameHostRuntime(games, {
      isHostReady: () => session.isHost() && bus.getStatus() === "ready",
      getRoomState: () => roomState.getState(),
      getRosterPlayerIds: () => this.roster.getPlayers().map((p) => p.playerId),
      logger: logger.child("games"),
    });

    return { session, presence, bus, roomState, lobby, chat, games, hostRuntime, cleanups: [] };
  }

  private wire(parts: Parts, playerId: string, initialNickname: string): void {
    const { session, presence, bus, roomState, lobby, chat } = parts;
    this.lastSavedNickname = initialNickname;
    this.stores.profiles.saveNickname(playerId, initialNickname);

    parts.cleanups.push(
      bus.onStatusChanged(() => {
        this.lifecycle.sync();
        parts.hostRuntime.reconcile();
      }),
      roomState.onChange((next, prev) => this.handleRoomStateChanged(next, prev)),

      session.onHostChanged((hostPeerId) => {
        if (this.roomId) this.seat.remember(this.roomId, playerId, seatSource(session));
        this.hostEm.emit(hostPeerId);
        this.lifecycle.sync();
        parts.hostRuntime.reconcile();
      }),

      chat.onMessage((line) => this.chatEm.emit(line)),

      lobby.onPlayerJoined((p) => this.relay(this.joinedEm, p)),
      lobby.onPlayerRejoined((p) => this.relay(this.rejoinedEm, p)),
      lobby.onPlayerUpdated((p) => this.relay(this.updatedEm, p)),
      lobby.onPlayerLeft((p) => this.relay(this.leftEm, p)),

      presence.onPresenceChanged(() => this.refreshPending()),
      presence.onSuperseded(() => this.handleSuperseded()),
      presence.onKicked(() => this.handleKicked()),

      // Nickname persistence is the client's job, not the UI's.
      session.onPlayerUpdated((p) => {
        const local = session.getLocalPlayer();
        if (!local || p.peerId !== local.peerId || p.nickname === this.lastSavedNickname) return;
        this.lastSavedNickname = p.nickname;
        this.stores.profiles.saveNickname(playerId, p.nickname);
      })
    );

    for (const [id, game] of parts.games) {
      parts.cleanups.push(
        game.channel.onChange(() => {
          this.gameBackend.emitSlot(id);
          parts.hostRuntime.reconcile();
        }),
        game.events.onEvent((event, from) =>
          this.gameBackend.emitEvent(id, event.name, event.data, from)
        )
      );
    }

    // A refresh fires pagehide (a deliberate leave removes this subscription first). Mark the
    // host claim so the reloaded tab knows its old peer is gone and can take the seat back at once.
    const roomId = this.roomId;
    if (roomId) parts.cleanups.push(this.seat.watchPageHide(roomId, seatSource(session)));
  }

  private handleSuperseded(): void {
    if (this.roomId) this.seat.forget(this.roomId);
    this.lifecycle.set("superseded");
    this.supersededEm.emit();
    this.lifecycle.sync();
    void this.teardown().then(() => this.lifecycle.sync());
  }

  private handleKicked(): void {
    if (this.roomId) this.seat.forget(this.roomId);
    this.lifecycle.set("kicked");
    this.kickedEm.emit();
    this.lifecycle.sync();
    void this.teardown().then(() => this.lifecycle.sync());
  }

  private teardown(): Promise<void> {
    this.teardownPromise ??= this.doTeardown().finally(() => {
      this.teardownPromise = undefined;
    });
    return this.teardownPromise;
  }

  // Order: client wiring -> bus -> presence -> session.
  private async doTeardown(): Promise<void> {
    const parts = this.parts;
    this.parts = undefined;
    this.lifecycle.resetSynced();
    this.roster.reset();
    if (!parts) return;
    try {
      this.disposeParts(parts);
    } finally {
      await parts.session.leave();
    }
  }

  private disposeParts(parts: Parts): void {
    for (const off of parts.cleanups) off();
    parts.cleanups.length = 0;
    parts.chat.dispose();
    parts.bus.dispose();
    parts.presence.dispose();
  }

  // ─── Getters (safe in any state) ──────────────────────────────────────────

  getStatus(): ClientStatus {
    return this.lifecycle.getStatus();
  }

  /** Undefined until the room state has synced once. After that it keeps the last known value through a re-sync. */
  getPhase(): RoomPhase | undefined {
    return this.lifecycle.getPhase();
  }

  getRoomId(): string | undefined {
    return this.roomId;
  }

  /** Kept after leave() so callers can rejoin with it. */
  getPlayerId(): string | undefined {
    return this.playerId;
  }

  getLocalPeerId(): SignalingPeerId | undefined {
    return this.parts?.session.getLocalPlayer()?.peerId;
  }

  isHost(): boolean {
    return this.parts?.session.isHost() ?? false;
  }

  getHostPeerId(): SignalingPeerId | undefined {
    return this.parts?.session.getHostPeerId();
  }

  /** True while a reconnecting guest's ready/team controls are locked. */
  isLocalPending(): boolean {
    return this.roster.isPending();
  }

  getPlayers(): LobbyPlayer[] {
    return this.roster.getPlayers();
  }

  getLocalPlayer(): LobbyPlayer | undefined {
    const peerId = this.getLocalPeerId();
    return peerId ? this.getPlayers().find((p) => p.peerId === peerId) : undefined;
  }

  getLobby(): LobbyInfo {
    return this.roster.getLobby();
  }

  getActiveGame(): ActiveGame | undefined {
    return this.lifecycle.hasSynced() ? this.parts?.roomState.getState().game : undefined;
  }

  getGameContext(): GameContext | undefined {
    return this.getActiveGame()?.context;
  }

  /** True when a game is running and this player was not part of it at start (a late joiner). */
  isSpectator(): boolean {
    const context = this.getGameContext();
    return !!context && !!this.playerId && !context.participants.includes(this.playerId);
  }

  /**
   * Diagnostic snapshot of the whole stack as plain JSON, computed on demand. Deliberately has no
   * matching callback and nothing in the app reads it. The shape is not a stable API.
   */
  getDebugState(): Record<string, unknown> {
    const parts = this.parts;
    return {
      lifecycle: this.lifecycle.get(),
      status: this.getStatus(),
      hasSynced: this.lifecycle.hasSynced(),
      phase: this.getPhase(),
      roomId: this.roomId,
      playerId: this.playerId,
      pending: this.isLocalPending(),
      lobby: this.getLobby(),
      players: this.getPlayers().map((p) => ({
        peerId: p.peerId,
        playerId: p.playerId,
        nickname: p.nickname,
        connection: p.connectionStatus,
        returning: p.returning,
        ready: p.ready,
        teamId: p.teamId,
      })),
      roomState: parts?.roomState.getState() ?? null,
      bus: parts?.bus.inspect() ?? null,
      presence: parts?.presence.inspect() ?? null,
      session: parts?.session.inspect() ?? null,
    };
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  onStatusChanged(handler: (status: ClientStatus) => void): () => void {
    return this.lifecycle.onStatusChanged(handler);
  }

  onPhaseChanged(handler: (phase: RoomPhase | undefined) => void): () => void {
    return this.lifecycle.onPhaseChanged(handler);
  }

  onHostChanged(handler: (hostPeerId: SignalingPeerId | undefined) => void): () => void {
    return this.hostEm.on(handler);
  }

  onPendingChanged(handler: (pending: boolean) => void): () => void {
    return this.roster.onPendingChanged(handler);
  }

  /** Fires once per successful join, before the status can become "ready". */
  onPlayerIdResolved(handler: (result: JoinResult) => void): () => void {
    return this.playerIdEm.on(handler);
  }

  onSuperseded(handler: () => void): () => void {
    return this.supersededEm.on(handler);
  }

  /** The host removed this player from the room. The client has already left. */
  onKicked(handler: () => void): () => void {
    return this.kickedEm.on(handler);
  }

  onPlayerJoined(handler: (player: LobbyPlayer) => void): () => void {
    return this.joinedEm.on(handler);
  }

  onPlayerRejoined(handler: (player: LobbyPlayer) => void): () => void {
    return this.rejoinedEm.on(handler);
  }

  onPlayerUpdated(handler: (player: LobbyPlayer) => void): () => void {
    return this.updatedEm.on(handler);
  }

  onPlayerLeft(handler: (player: LobbyPlayer) => void): () => void {
    return this.leftEm.on(handler);
  }

  /** Fires only when the roster actually changed (same array reference otherwise). */
  onPlayersChanged(handler: (players: LobbyPlayer[]) => void): () => void {
    return this.roster.onPlayersChanged(handler);
  }

  /** Mode, team ids or all-ready changed. */
  onLobbyChanged(handler: (lobby: LobbyInfo) => void): () => void {
    return this.roster.onLobbyChanged(handler);
  }

  /** A game started, ended, or its context changed. */
  onGameChanged(handler: (game: ActiveGame | undefined) => void): () => void {
    return this.gameEm.on(handler);
  }

  getChat(): readonly ChatLine[] {
    return this.parts?.chat.getHistory() ?? EMPTY_CHAT;
  }

  /** Fires for every message, including your own. getChat() is already updated when it runs. */
  onChatMessage(handler: (line: ChatLine) => void): () => void {
    return this.chatEm.on(handler);
  }

  /** Omit `toPeerId` to message everyone. Anything other than "sent" means nothing went out, so keep the draft. */
  sendChat(text: string, toPeerId?: string): ChatSendResult {
    return this.parts?.chat.send(text, toPeerId) ?? "not-ready";
  }

  // ─── Intents: local player (no-ops when not joined) ───────────────────────

  setNickname(nickname: string): void {
    const trimmed = nickname.trim();
    if (trimmed) this.parts?.lobby.setNickname(trimmed);
  }

  setReady(ready: boolean): void {
    this.parts?.lobby.setReady(ready);
  }

  chooseTeam(teamId: string): void {
    this.parts?.lobby.chooseTeam(teamId);
  }

  leaveTeam(): void {
    this.parts?.lobby.leaveTeam();
  }

  // ─── Intents: coordination (host-only; resolve with the host's verdict) ───

  switchToFreeForAll(): Promise<CommandResult> {
    return (
      this.parts?.roomState.switchLobby({ mode: "free-for-all" }) ?? Promise.resolve(NOT_JOINED)
    );
  }

  switchToTeams(teamIds: string[]): Promise<CommandResult> {
    return (
      this.parts?.roomState.switchLobby({ mode: "teams", teamIds }) ?? Promise.resolve(NOT_JOINED)
    );
  }

  /** Host-only. The config type is checked against the game definition. */
  startGame<C, S, Cmds extends object, Evs extends object, M extends LobbyMode>(
    game: GameDefinition<C, S, Cmds, Evs, M>,
    config: C
  ): Promise<CommandResult> {
    return this.startGameById(game.id, config);
  }

  /**
   * Host only. Hands the host role to another connected player; the room and any running game
   * carry on. Rejected reasons: not-host, not-ready (the room is re-syncing), unknown-player,
   * target-unavailable (no active link yet), host-changed (someone else became host first).
   */
  async transferHost(peerId: SignalingPeerId): Promise<CommandResult> {
    const parts = this.parts;
    if (!parts) return NOT_JOINED;
    const reject = (reason: string): CommandResult => ({ ok: false, kind: "rejected", reason });

    if (!parts.session.isHost()) return reject("not-host");
    if (parts.bus.getStatus() !== "ready") return reject("not-ready");
    if (peerId === this.getLocalPeerId() || !this.getPlayers().some((p) => p.peerId === peerId)) {
      return reject("unknown-player");
    }
    const result = await parts.session.transferHost(peerId);
    return result === "transferred" ? { ok: true } : reject(result);
  }

  /** Host only. Removes a player from the room; they are told why. They may rejoin through the invite link. */
  async kickPlayer(peerId: SignalingPeerId): Promise<CommandResult> {
    const parts = this.parts;
    if (!parts) return NOT_JOINED;
    const reject = (reason: string): CommandResult => ({ ok: false, kind: "rejected", reason });
    if (!parts.session.isHost()) return reject("not-host");
    if (peerId === this.getLocalPeerId()) return reject("cannot-kick-self");
    return parts.presence.kickPlayer(peerId) ? { ok: true } : reject("unknown-player");
  }

  private startGameById(gameId: string, config: unknown): Promise<CommandResult> {
    const parts = this.parts;
    if (!parts) return Promise.resolve(NOT_JOINED);
    const lobby = parts.roomState.getState().lobby;
    return parts.roomState.startGame({
      id: gameId,
      config,
      context: this.roster.freezeContext(lobby),
    });
  }

  /** The typed handle for a registered game. Same handle every call. */
  getGame<C, S, Cmds extends object, Evs extends object, M extends LobbyMode>(
    game: GameDefinition<C, S, Cmds, Evs, M>
  ): GameHandle<C, S, Cmds, Evs, M> {
    if (!this.registry.has(game.id)) {
      throw new Error(`[MultiplayerClient] Game "${game.id}" is not registered.`);
    }
    let handle = this.handles.get(game.id) as GameHandle<C, S, Cmds, Evs, M> | undefined;
    if (!handle) {
      handle = new GameHandle(game, this.gameBackend);
      this.handles.set(game.id, handle);
    }
    return handle;
  }

  endGame(): Promise<CommandResult> {
    return this.parts?.roomState.endGame() ?? Promise.resolve(NOT_JOINED);
  }

  // ─── Private: derived state ───────────────────────────────────────────────

  private handleRoomStateChanged(next: RoomState, prev: RoomState): void {
    if (JSON.stringify(next.lobby) !== JSON.stringify(prev.lobby)) {
      this.parts?.lobby.applyConfig(next.lobby);
    }
    // Round or lobby config changes alter ready/team projections.
    this.refreshPlayers();
    this.lifecycle.sync();

    if (next.phase !== prev.phase || JSON.stringify(next.game) !== JSON.stringify(prev.game)) {
      this.gameEm.emit(this.getActiveGame());
    }

    this.gameBackend.emitAllSlots(); // isActive may have flipped
    this.parts?.hostRuntime.reconcile();
  }

  private relay(emitter: Emitter<LobbyPlayer>, player: LobbyPlayer): void {
    this.refreshPlayers(); // cache first, so handlers read fresh getters
    emitter.emit(player);
  }

  private refreshPlayers(): void {
    if (this.roster.refresh(this.parts?.lobby)) this.parts?.hostRuntime.reconcile(); // late joiners
  }

  private refreshPending(): void {
    this.roster.refreshPending(this.parts?.presence);
  }

  private readonly gameBackend = new ClientGameBackend(
    {
      getRoomState: () => this.parts?.roomState.getState(),
      getGame: (id) => this.parts?.games.get(id),
      isSynced: () => this.lifecycle.hasSynced(),
      getPlayerId: () => this.playerId,
      start: (id, config) => this.startGameById(id, config),
    },
    this.onListenerError
  );
}
