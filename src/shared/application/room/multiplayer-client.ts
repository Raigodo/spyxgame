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
  type LobbyConfig,
  type LobbyMode,
  type LobbyPlayer,
} from "@/shared/application/lobby";
import {
  EventChannel,
  RoomBus,
  StateChannel,
  createSessionTransport,
  type CommandResult,
} from "@/shared/application/messaging";
import {
  Emitter,
  PageLifecycle,
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
  type GameBackend,
  type GameDefinition,
  type GameRuntime,
  type RegisteredGame,
  type Slot,
  type SlotValue,
} from "@/shared/application/game";

export type ClientStatus = "idle" | "joining" | "syncing" | "ready" | "superseded" | "kicked";

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
  createSession(): PlayerSession;
  stores: PlayerStores;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
  config: AppConfig;
  pageLifecycle: PageLifecycle;
}

interface GameEvent {
  name: string;
  data: unknown;
}

interface GameEventDelivery extends GameEvent {
  from: string;
}

interface GameParts {
  runtime: GameRuntime;
  channel: StateChannel<SlotValue>;
  events: EventChannel<GameEvent>;
}

export interface LobbyInfo {
  mode: LobbyMode;
  teamIds: readonly string[];
  allReady: boolean;
}

type Lifecycle = "idle" | "joining" | "joined" | "superseded" | "kicked";

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

const DEFAULT_LOBBY_INFO: LobbyInfo = { mode: "free-for-all", teamIds: [], allReady: false };
const NOT_JOINED: CommandResult = { ok: false, kind: "left", reason: "not joined" };
const EMPTY_CHAT: readonly ChatLine[] = [];

const rosterKey = (p: LobbyPlayer) =>
  JSON.stringify([
    p.peerId,
    p.playerId,
    p.nickname,
    p.connectionStatus,
    p.returning,
    p.ready,
    p.teamId,
  ]);

function sameRoster(a: LobbyPlayer[], b: LobbyPlayer[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const other = b[i];
      return other !== undefined && rosterKey(p) === rosterKey(other);
    })
  );
}

const sameLobbyInfo = (a: LobbyInfo, b: LobbyInfo) =>
  a.mode === b.mode &&
  a.allReady === b.allReady &&
  a.teamIds.join("\u0000") === b.teamIds.join("\u0000");

export class MultiplayerClient {
  private lifecycle: Lifecycle = "idle";
  private parts?: Parts;
  private roomId?: string;
  private playerId?: string;

  // Cached derived values (stable references between changes).
  private status: ClientStatus = "idle";
  private hasSynced = false;
  private phase?: RoomPhase;
  private players: LobbyPlayer[] = [];
  private lobbyInfo: LobbyInfo = DEFAULT_LOBBY_INFO;
  private pending = false;

  private inFlightJoin?: Promise<unknown>;
  private teardownPromise?: Promise<void>;
  private lastSavedNickname?: string;

  private readonly statusEm = new Emitter<ClientStatus>();
  private readonly phaseEm = new Emitter<RoomPhase | undefined>();
  private readonly hostEm = new Emitter<SignalingPeerId | undefined>();
  private readonly pendingEm = new Emitter<boolean>();
  private readonly playerIdEm = new Emitter<JoinResult>();
  private readonly supersededEm = new Emitter();
  private readonly kickedEm = new Emitter();
  private readonly joinedEm = new Emitter<LobbyPlayer>();
  private readonly rejoinedEm = new Emitter<LobbyPlayer>();
  private readonly updatedEm = new Emitter<LobbyPlayer>();
  private readonly leftEm = new Emitter<LobbyPlayer>();
  private readonly playersEm = new Emitter<LobbyPlayer[]>();
  private readonly lobbyEm = new Emitter<LobbyInfo>();
  private readonly gameEm = new Emitter<ActiveGame | undefined>();
  private readonly chatEm = new Emitter<ChatLine>();

  private readonly registry = new Map<string, RegisteredGame>();
  private readonly handles = new Map<string, object>();
  private readonly slotEms = new Map<string, Emitter>();
  private readonly eventEms = new Map<string, Emitter<GameEventDelivery>>();
  private readonly roomOptions: RoomStateOptions;

  constructor(
    options: ClientOptions,
    private readonly deps: ClientDeps
  ) {
    for (const game of options.games ?? []) {
      if (this.registry.has(game.id))
        throw new Error(`[MultiplayerClient] Duplicate game "${game.id}".`);
      this.registry.set(game.id, game);
    }
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
    if (this.lifecycle !== "idle") {
      throw new Error(
        `[MultiplayerClient] Cannot join while ${this.lifecycle}. Call leave() first.`
      );
    }
    const attempt = this.performJoin(options); // sets lifecycle synchronously
    this.inFlightJoin = attempt.catch(() => undefined);
    return attempt;
  }

  /** Idempotent. Safe to call after a failed join, during a join, or twice. */
  async leave(): Promise<void> {
    await this.inFlightJoin; // let a pending join settle, then tear it down properly
    if (this.roomId) this.stores.hostClaims.forget(this.roomId); // a deliberate leave never reclaims
    await this.teardown();
    this.lifecycle = "idle";
    this.roomId = undefined;
    this.syncDerived();
  }

  private async performJoin(options: JoinOptions): Promise<JoinResult> {
    this.lifecycle = "joining";
    this.roomId = options.roomId;
    this.syncDerived();

    const suppliedId = options.playerId?.trim();
    const playerId = suppliedId || this.deps.ids.next();
    const result: JoinResult = { playerId, generated: !suppliedId };
    const nickname =
      options.nickname?.trim() || this.stores.profiles.load(playerId)?.nickname || "Player";

    // peerId is deliberately not passed: it must be fresh per join.
    const session = this.deps.createSession();
    let parts: Parts | undefined;
    try {
      await session.join(options.roomId, buildLocalProfileInput(playerId, nickname), {
        formerHost: this.stores.hostClaims.recall(options.roomId, playerId),
      });

      parts = this.assemble(session);
      this.parts = parts; // before start(): handlers fired by start() already see it
      this.wire(parts, playerId, nickname);
      parts.bus.start();
      // A room creator's host event fires during join(), before wire() subscribed, so remember
      // the seat here as well as in the host-changed handler.
      this.rememberHostSeat(session, playerId);
    } catch (error) {
      this.parts = undefined;
      if (parts) this.disposeParts(parts);
      await session.leave().catch(() => {});
      this.lifecycle = "idle";
      this.syncDerived();
      throw error;
    }

    this.playerId = playerId;
    this.lifecycle = "joined";
    this.refreshPlayers();
    this.refreshPending();
    this.playerIdEm.emit(result); // before callers can see status "ready"
    this.syncDerived();
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
          if (typeof raw !== "object" || raw === null) return undefined;
          const { name, data } = raw as { name?: unknown; data?: unknown };
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
      getRosterPlayerIds: () => this.players.map((p) => p.playerId),
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
        this.syncDerived();
        parts.hostRuntime.reconcile();
      }),
      roomState.onChange((next, prev) => this.handleRoomStateChanged(next, prev)),

      session.onHostChanged((hostPeerId) => {
        this.rememberHostSeat(session, playerId);
        this.hostEm.emit(hostPeerId);
        this.syncDerived();
        parts.hostRuntime.reconcile();
      }),

      chat.onMessage((line) => this.chatEm.emit(line)),

      lobby.onPlayerJoined((p) => this.relay(this.joinedEm, p)),
      lobby.onPlayerRejoined((p) => this.relay(this.rejoinedEm, p)),
      lobby.onPlayerUpdated((p) => this.relay(this.updatedEm, p)),
      lobby.onPlayerLeft((p) => this.relay(this.leftEm, p)),

      presence.onPresenceChanged(() => this.refreshPending()),
      presence.onSessionSuperseded(() => this.handleSuperseded()),
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
          this.slotEmitter(id).emit();
          parts.hostRuntime.reconcile();
        }),
        game.events.onEvent((event, from) =>
          this.eventEmitter(id).emit({ name: event.name, data: event.data, from })
        )
      );
    }

    // A refresh fires pagehide (a deliberate leave removes this subscription first). Mark the
    // host claim so the reloaded tab knows its old peer is gone and can take the seat back at once.
    parts.cleanups.push(
      this.deps.pageLifecycle.onPageHide(() => {
        if (session.isHost() && this.roomId) this.stores.hostClaims.markLeaving(this.roomId);
      })
    );
  }

  // Remember the host seat so a page refresh can take it back. Called from the host-changed
  // handler and right after start.
  private rememberHostSeat(session: PlayerSession, playerId: string): void {
    const localPeerId = session.getLocalPlayer()?.peerId;
    if (session.isHost() && localPeerId && this.roomId) {
      this.stores.hostClaims.remember(this.roomId, playerId, localPeerId);
    }
  }

  private handleSuperseded(): void {
    if (this.roomId) this.stores.hostClaims.forget(this.roomId);
    this.lifecycle = "superseded";
    this.supersededEm.emit();
    this.syncDerived();
    void this.teardown().then(() => this.syncDerived());
  }

  private handleKicked(): void {
    if (this.roomId) this.stores.hostClaims.forget(this.roomId);
    this.lifecycle = "kicked";
    this.kickedEm.emit();
    this.syncDerived();
    void this.teardown().then(() => this.syncDerived());
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
    this.hasSynced = false;
    this.players = [];
    this.lobbyInfo = DEFAULT_LOBBY_INFO;
    this.pending = false;
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
    return this.status;
  }

  /** Undefined until the room state has synced once. After that it keeps the last known value through a re-sync. */
  getPhase(): RoomPhase | undefined {
    return this.phase;
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
    return this.pending;
  }

  getPlayers(): LobbyPlayer[] {
    return this.players;
  }

  getLocalPlayer(): LobbyPlayer | undefined {
    const peerId = this.getLocalPeerId();
    return peerId ? this.players.find((p) => p.peerId === peerId) : undefined;
  }

  getLobby(): LobbyInfo {
    return this.lobbyInfo;
  }

  getActiveGame(): ActiveGame | undefined {
    return this.hasSynced ? this.parts?.roomState.getState().game : undefined;
  }

  getGameContext(): GameContext | undefined {
    return this.getActiveGame()?.context;
  }

  /** True when a game is running and this player was not part of it at start (a late joiner). */
  isSpectator(): boolean {
    const context = this.getGameContext();
    return !!context && !!this.playerId && !context.participants.includes(this.playerId);
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  onStatusChanged(handler: (status: ClientStatus) => void): () => void {
    return this.statusEm.on(handler);
  }

  onPhaseChanged(handler: (phase: RoomPhase | undefined) => void): () => void {
    return this.phaseEm.on(handler);
  }

  onHostChanged(handler: (hostPeerId: SignalingPeerId | undefined) => void): () => void {
    return this.hostEm.on(handler);
  }

  onPendingChanged(handler: (pending: boolean) => void): () => void {
    return this.pendingEm.on(handler);
  }

  /** Fires once per successful join, before the status can become "ready". */
  onPlayerIdResolved(handler: (result: JoinResult) => void): () => void {
    return this.playerIdEm.on(handler);
  }

  onSessionSuperseded(handler: () => void): () => void {
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
    return this.playersEm.on(handler);
  }

  /** Mode, team ids or all-ready changed. */
  onLobbyChanged(handler: (lobby: LobbyInfo) => void): () => void {
    return this.lobbyEm.on(handler);
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
    if (peerId === this.getLocalPeerId() || !this.players.some((p) => p.peerId === peerId)) {
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
    return parts.roomState.startGame({ id: gameId, config, context: this.freezeContext(lobby) });
  }

  /** The typed handle for a registered game. Same handle every call. */
  useGame<C, S, Cmds extends object, Evs extends object, M extends LobbyMode>(
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

  private freezeContext(lobby: LobbyConfig): GameContext {
    const teams: Record<string, string> = {};
    const participants: string[] = [];
    for (const p of this.players) {
      participants.push(p.playerId);
      if (lobby.mode === "teams" && p.teamId) teams[p.playerId] = p.teamId;
    }
    return { lobby, teams, participants };
  }

  private handleRoomStateChanged(next: RoomState, prev: RoomState): void {
    if (JSON.stringify(next.lobby) !== JSON.stringify(prev.lobby)) {
      this.parts?.lobby.applyConfig(next.lobby);
    }
    // Round or lobby config changes alter ready/team projections.
    this.refreshPlayers();
    this.syncDerived();

    if (next.phase !== prev.phase || JSON.stringify(next.game) !== JSON.stringify(prev.game)) {
      this.gameEm.emit(this.getActiveGame());
    }

    for (const emitter of this.slotEms.values()) emitter.emit(); // isActive may have flipped
    this.parts?.hostRuntime.reconcile();
  }

  private relay(emitter: Emitter<LobbyPlayer>, player: LobbyPlayer): void {
    this.refreshPlayers(); // cache first, so handlers read fresh getters
    emitter.emit(player);
  }

  private refreshPlayers(): void {
    const lobby = this.parts?.lobby;
    const nextPlayers = lobby ? lobby.getPlayers() : [];
    const playersChanged = !sameRoster(this.players, nextPlayers);
    if (playersChanged) this.players = nextPlayers;

    const config = lobby?.getConfig();
    const nextInfo: LobbyInfo =
      lobby && config
        ? {
            mode: config.mode,
            teamIds: config.mode === "teams" ? config.teamIds : [],
            allReady: lobby.areAllPlayersReady(),
          }
        : DEFAULT_LOBBY_INFO;
    const infoChanged = !sameLobbyInfo(this.lobbyInfo, nextInfo);
    if (infoChanged) this.lobbyInfo = nextInfo;

    if (playersChanged) this.playersEm.emit(this.players);
    if (infoChanged) this.lobbyEm.emit(this.lobbyInfo);

    if (playersChanged) this.parts?.hostRuntime.reconcile(); // late joiners
  }

  private refreshPending(): void {
    const next = this.parts?.presence.isLocalPending() ?? false;
    if (next === this.pending) return;
    this.pending = next;
    this.pendingEm.emit(next);
  }

  private computeStatus(): ClientStatus {
    switch (this.lifecycle) {
      case "idle":
        return "idle";
      case "joining":
        return "joining";
      case "superseded":
        return "superseded";
      case "kicked":
        return "kicked";
      case "joined":
        return this.parts?.bus.getStatus() ?? "syncing";
    }
  }

  private syncDerived(): void {
    const status = this.computeStatus();
    if (status === "ready") this.hasSynced = true;

    const phase = this.hasSynced ? this.parts?.roomState.getState().phase : undefined;

    if (status !== this.status) {
      this.status = status;
      this.statusEm.emit(status);
    }
    if (phase !== this.phase) {
      this.phase = phase;
      this.phaseEm.emit(phase);
    }
  }

  private slotEmitter(id: string): Emitter {
    let emitter = this.slotEms.get(id);
    if (!emitter) this.slotEms.set(id, (emitter = new Emitter()));
    return emitter;
  }

  private eventEmitter(id: string): Emitter<GameEventDelivery> {
    let emitter = this.eventEms.get(id);
    if (!emitter) this.eventEms.set(id, (emitter = new Emitter<GameEventDelivery>()));
    return emitter;
  }

  private readonly gameBackend: GameBackend = {
    getSlot: (id): Slot | null => {
      const room = this.parts?.roomState.getState();
      const slot = this.parts?.games.get(id)?.channel.get() ?? null;
      const current =
        !!room &&
        this.hasSynced &&
        room.phase === "in-game" &&
        room.game?.id === id &&
        slot?.round === room.round;
      return current ? slot : null;
    },
    getLocalPlayerId: () => this.playerId,
    sendCommand: (id, name, payload) =>
      this.parts?.games.get(id)?.channel.send(name, payload) ?? Promise.resolve(NOT_JOINED),
    sendEvent: (id, name, data, toPeerId) => {
      const game = this.parts?.games.get(id);
      if (!game || game.runtime.validateEvent(name, data) === undefined) return false;
      if (toPeerId === undefined) game.events.broadcast({ name, data });
      else game.events.sendTo(toPeerId, { name, data });
      return true;
    },
    start: (id, config) => this.startGameById(id, config),
    onSlotChanged: (id, handler) => this.slotEmitter(id).on(handler),
    onEvent: (id, handler) =>
      this.eventEmitter(id).on(({ name, data, from }) => handler(name, data, from)),
  };
}
