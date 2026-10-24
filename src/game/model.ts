// The game feature's types: the replicated data, the author-facing definition, the client API and
// the contracts between the feature's own modules. Types only, no runtime code.
// Contract: docs/rewrite/zoom-5-game.md. Where this file differs, see docs/rewrite/g0-plan.md.

import type { Bus, BusFailure, BusReject } from "@/bus";
import type {
  Clock,
  Entropy,
  Issue,
  Listenable,
  Logger,
  PeerId,
  PlayerId,
  Result,
  RoomId,
  Schema,
  Storages,
  Store,
} from "@/kernel";
import type { GameConfig } from "./config";
import type { LOBBY_MODES } from "./names";

export type LobbyMode = (typeof LOBBY_MODES)[number];

// ─── Replicated data (the `game` channel) ───────────────────────────────────

/** Frozen from lobby and roster at `start`; then changed only by `observe`. */
export type SlotSetup = {
  mode: LobbyMode;
  teamIds?: string[];
  /** playerId -> teamId. */
  teams: Record<string, string>;
  participants: PlayerId[];
  spectators: PlayerId[];
  /** playerId -> nickname, includes players who left. */
  names: Record<string, string>;
};

export type Slot = {
  gameId: string;
  version: number;
  /** From the Entropy port, once per round. */
  seed: number;
  /** Unvalidated while the game id is unknown to this build (opaque slot). */
  settings: unknown;
  state: unknown;
  setup: SlotSetup;
  /** Slot features by key. */
  x: Record<string, unknown>;
};

export type LastGame = { gameId: string; settings: unknown };

export type GameState = { round: number; last?: LastGame; slot: Slot | null };

// ─── Game author types ──────────────────────────────────────────────────────

export type GameTypes = {
  settings: unknown;
  state: unknown;
  /** A union discriminated by `type`. */
  command: { type: string };
  /** A union discriminated by `type`: notices and ephemeral events. */
  event: { type: string };
  /** Reasons the game's reducers return. */
  reject: string;
  private?: unknown;
  /** Narrows `setup`. Default: both modes. */
  mode?: LobbyMode;
};

export type ModeOf<T> = T extends { mode: infer M extends LobbyMode } ? M : LobbyMode;
export type PrivateOf<T> = T extends { private: infer P } ? P : undefined;

/** What a game sees of the lobby it was started from, narrowed by its modes. */
export type SetupOf<M extends LobbyMode> = M extends "teams"
  ? {
      mode: "teams";
      teamIds: readonly string[];
      teams: Readonly<Record<string, string>>;
      participants: readonly PlayerId[];
    }
  : { mode: "free-for-all"; participants: readonly PlayerId[] };

export type Sender = { playerId: PlayerId; peerId: PeerId };

/** The host's view of one player's private piece. */
export type PrivateView<P> = { get(playerId: PlayerId): P | undefined };

export type Effect<T extends GameTypes> =
  | { type: "startTimer"; id: string; timer: string; afterMs: number; payload?: unknown }
  | { type: "cancelTimer"; id: string }
  | { type: "emit"; event: T["event"] }
  | { type: "end" };

/** An effect as it travels through the slot pipeline, before a feature checks it. */
export type RawEffect = { type: string; [key: string]: unknown };

export type Outcome<T extends GameTypes> = Result<
  {
    state: T["state"];
    effects?: readonly Effect<T>[];
    /** playerId -> new private piece, or null to remove it. */
    private?: Record<string, T["private"] | null>;
  },
  T["reject"]
>;

type Common<T extends GameTypes> = {
  state: T["state"];
  settings: T["settings"];
  setup: SetupOf<ModeOf<T>>;
  away: readonly PlayerId[];
  seed: number;
  private: PrivateView<T["private"]>;
};

/** Reducer arguments. Game logic never reads a clock: there is no `now`. */
export type ReduceArgs<T extends GameTypes> = Common<T> & { sender: Sender };
export type TimerArgs<T extends GameTypes> = Common<T>;
/** Arguments of `late`, `presence` callbacks and `private` hooks: who is where. */
export type RosterArgs<T extends GameTypes> = Common<T> & {
  names: Readonly<Record<string, string>>;
};

export type CommandWho = "participant" | "host" | "anyone";

export type PresenceChange = {
  playerId: PlayerId;
  /** away: marked absent. returned: back in place. dropped: moved to spectators. */
  kind: "away" | "returned" | "dropped";
};
export type RejoinStrategy = "restore" | "spectate";
export type BelowMin = "continue" | "pause" | "end";

export type PresenceRules<T extends GameTypes> = {
  /** Default: `GameConfig.awayAfterMs`. */
  awayAfterMs?: number;
  /** Default "restore". */
  rejoin?: RejoinStrategy | ((a: RosterArgs<T> & { playerId: PlayerId }) => RejoinStrategy);
  /** Participants not away below this trigger `belowMin`. Default: no minimum. */
  minPresent?: number;
  /** Default "continue". */
  belowMin?: BelowMin;
  /** Pure. Runs on the host when players go away, return or are dropped. undefined: leave alone. */
  onChange?(
    a: RosterArgs<T> & { changes: readonly PresenceChange[] }
  ): Extract<Outcome<T>, { ok: true }>["value"] | undefined;
};

export type LateDecision<T extends GameTypes> = {
  /** Required in teams mode, ignored otherwise. */
  team?: string;
  state?: T["state"];
  /** Take over the seat of this away participant. Works at the player cap. */
  replaces?: PlayerId;
  private?: T["private"];
};

export type PrivateSpec<T extends GameTypes> = {
  schema: Schema<T["private"]>;
  /** A participant's starting piece (start, admitted late joiners). */
  initial?(a: RosterArgs<T> & { playerId: PlayerId }): T["private"] | undefined;
  /** Pure. Rebuilds a piece the host lost, from replicated state. */
  recover?(a: RosterArgs<T> & { playerId: PlayerId }): T["private"] | undefined;
};

export type Migrate = (raw: unknown, fromVersion: number) => unknown;

type CommandOf<T extends GameTypes, K extends string> = Extract<T["command"], { type: K }>;
type EventOf<T extends GameTypes, K extends string> = Extract<T["event"], { type: K }>;

/** What `defineGame` takes. */
export type GameSpec<T extends GameTypes> = {
  id: string;
  /** Bump when the shape of settings or state changes. Default 1. */
  version?: number;
  migrate?: { state?: Migrate; settings?: Migrate };
  modes: readonly ModeOf<T>[];
  players?: { min?: number; max?: number };
  settings: Schema<T["settings"]>;
  state: Schema<T["state"]>;
  init(a: { settings: T["settings"]; setup: SetupOf<ModeOf<T>>; seed: number }): T["state"];
  /** A new command type does not compile without a handler. */
  commands: {
    [K in T["command"]["type"]]: {
      who?: CommandWho;
      schema: Schema<CommandOf<T, K>>;
      reduce(a: ReduceArgs<T>, command: CommandOf<T, K>): Outcome<T>;
    };
  };
  events?: { [K in T["event"]["type"]]: { schema: Schema<EventOf<T, K>> } };
  timers?: {
    [timer: string]: {
      schema?: Schema<unknown>;
      reduce(a: TimerArgs<T>, payload: unknown): Outcome<T>;
    };
  };
  /** Late joiners are spectators unless this admits them. Once per player, on the host. */
  late?(a: RosterArgs<T> & { playerId: PlayerId }): LateDecision<T> | undefined;
  presence?: PresenceRules<T>;
  private?: PrivateSpec<T>;
};

// ─── The non-generic runtime (only the framework sees it) ───────────────────

/** What one reducer call produced, with the game's types erased. */
export type Reduction = {
  state: unknown;
  effects: readonly RawEffect[];
  private?: Record<string, unknown>;
};

export type StartInput = { settings: unknown; setup: SlotSetup; seed: number };
export type StartPlan = { settings: unknown; state: unknown; private: Record<string, unknown> };

export type LateOutcome = {
  team?: string;
  replaces?: PlayerId;
  state?: unknown;
  private?: unknown;
};

/** Pure functions over erased values. Built by `defineGame`, used by rules, slot features and state. */
export interface GameRuntime {
  readonly id: string;
  readonly version: number;
  readonly modes: readonly LobbyMode[];
  readonly players: { min: number; max: number };
  readonly presence: {
    awayAfterMs?: number;
    minPresent?: number;
    belowMin: BelowMin;
  };
  /** Migrates an older version first. */
  parseSettings(raw: unknown, fromVersion: number): Result<unknown, Issue>;
  parseState(raw: unknown, fromVersion: number): Result<unknown, Issue>;
  /** undefined: unknown timer or invalid payload. */
  parseTimerPayload(timer: string, raw: unknown): { value: unknown } | undefined;
  /** undefined: invalid. */
  parseEvent(raw: unknown): { value: unknown } | undefined;
  /** undefined: invalid (or the game has no private pieces). */
  parsePrivate(raw: unknown): { value: unknown } | undefined;
  /** undefined: no such command. */
  commandWho(type: string): CommandWho | undefined;
  start(
    input: StartInput
  ): Result<
    StartPlan,
    "invalid-settings" | "unsupported-mode" | "too-few-players" | "too-many-players"
  >;
  /** Validates the command (`"invalid"`), then runs its reducer. */
  play(
    slot: Slot,
    command: unknown,
    sender: Sender,
    view: PrivateView<unknown>
  ): Result<Reduction, string>;
  /** undefined: no handler for this timer. */
  fire(
    slot: Slot,
    timer: string,
    payload: unknown,
    view: PrivateView<unknown>
  ): Result<Reduction, string> | undefined;
  late(slot: Slot, playerId: PlayerId): LateOutcome | undefined;
  rejoin(slot: Slot, playerId: PlayerId): RejoinStrategy;
  /** Runs `presence.onChange`. undefined: nothing to change. */
  changed(
    slot: Slot,
    changes: readonly PresenceChange[],
    view: PrivateView<unknown>
  ): Reduction | undefined;
  initialPrivate(slot: Slot, playerId: PlayerId): unknown;
  recoverPrivate(slot: Slot, playerId: PlayerId): unknown;
}

/** What `defineGame` returns. `T` is carried only for inference (`__types` is never set). */
export interface GameDef<T extends GameTypes = GameTypes> {
  readonly id: string;
  readonly modes: readonly LobbyMode[];
  readonly runtime: GameRuntime;
  readonly __types?: T;
}

/** A definition with its types erased: what the registry and `GameDeps` hold. */
export type RegisteredGame = Pick<GameDef, "id" | "modes" | "runtime">;

// ─── Slot features (internal contract of slot/) ─────────────────────────────

export type ObservedPlayer = { id: PlayerId; name: string; here: boolean };
export type Observation = { players: readonly ObservedPlayer[]; removed: readonly PlayerId[] };

export type ParseEnv = { config: GameConfig; runtime: GameRuntime };
export type SlotEnv = ParseEnv & {
  now: number;
  /** `GameState.round`: private writes are stamped with it. */
  round: number;
  private: PrivateView<unknown>;
};

export type ObserveResult = {
  slot: Slot;
  effects?: readonly RawEffect[];
  /** playerId -> new private piece, or null to remove it (same meaning as `Reduction.private`). */
  private?: Record<string, unknown>;
};

export interface SlotFeature<X> {
  /** `slot.x[key]`. */
  key: string;
  initial(setup: SlotSetup): X;
  /** Network input. A missing key (older host) returns the default, a malformed one undefined. */
  parse(raw: unknown, setup: SlotSetup, env: ParseEnv): X | undefined;
  effect?: {
    types: readonly string[];
    /** `slot` is read-only context (a timer started while paused starts frozen). */
    apply(x: X, effect: RawEffect, env: SlotEnv, slot: Slot): Result<X, "invalid-effect">;
  };
  /** Pure, the host's sync step. Returns the same slot reference when nothing changed. */
  observe?(slot: Slot, observation: Observation, env: SlotEnv): ObserveResult;
}

// ─── Commands on the `game` channel (internal) ──────────────────────────────

export type GameCommand =
  | { type: "start"; gameId: string; settings: unknown; setup: SlotSetup; seed: number }
  | { type: "play"; gameId: string; command: unknown }
  | { type: "observe"; players: readonly ObservedPlayer[]; removed: readonly PlayerId[] }
  | { type: "fire"; id: string }
  | { type: "continue" }
  | { type: "end" };

// ─── Rejections ─────────────────────────────────────────────────────────────

export type StartReject =
  | "not-host"
  | "not-ready"
  | "already-playing"
  | "unknown-game"
  | "unsupported-mode"
  | "too-few-players"
  | "too-many-players"
  | "invalid-settings";

/** The play gate (`authorize`, in this order). */
export type PlayGateReject =
  | "no-active-game"
  | "wrong-game"
  | "unknown-command"
  | "unknown-game"
  | "paused"
  | "host-only"
  | "not-a-participant";

/** What `send` can add to the game's own reasons (the bus's rejections are included). */
export type PlayError = PlayGateReject | BusReject;

export type EndReject = "not-host" | "not-playing" | "not-ready";
export type ContinueReject = "not-host" | "not-paused" | "not-ready";

// ─── Client side ────────────────────────────────────────────────────────────

export type ViewRole = "player" | "spectator";

export type ViewPlayer = { id: PlayerId; name: string; role: ViewRole; away: boolean };

/** A running (or, while paused, frozen) timer. `deadlineAt` is display data, never game logic. */
export type GameTimer = {
  id: string;
  timer: string;
  payload: unknown;
  /** Host time in ms. */
  deadlineAt: number;
  paused: boolean;
  /** Time left while paused. */
  remainingMs?: number;
};

/** One atomic snapshot, with a stable reference until a part changes. */
export type GameView<T extends GameTypes> = {
  round: number;
  settings: T["settings"];
  state: T["state"];
  setup: SetupOf<ModeOf<T>>;
  me: { playerId: PlayerId; role: ViewRole; team?: string; private?: PrivateOf<T> };
  players: readonly ViewPlayer[];
  away: readonly PlayerId[];
  paused: boolean;
  notices: readonly T["event"][];
  timers: readonly GameTimer[];
};

export type LocalStateDef<L> = {
  /** `LOCAL_ID_PATTERN`. */
  id: string;
  schema: Schema<L>;
  initial(): L;
};

export interface GameHandle<T extends GameTypes> {
  /** undefined unless this game is the active one and synced. */
  readonly view: Store<GameView<T> | undefined>;
  send(command: T["command"]): Promise<Result<void, T["reject"] | PlayError | BusFailure>>;
  /** Ephemeral, from `game-events`. */
  readonly events: Listenable<{ event: T["event"]; from: PeerId }>;
  /** Each notice once, from state, on every peer. Never replays on subscribe. */
  readonly noticed: Listenable<T["event"]>;
  /** false: no active game or not synced. */
  broadcast(event: T["event"]): boolean;
  /** false: no active game, not synced, or the player has no peer (a ghost). */
  sendTo(id: PlayerId, event: T["event"]): boolean;
  continueAnyway(): Promise<Result<void, ContinueReject>>;
  /** Device-only, per round and player. */
  local<L>(def: LocalStateDef<L>): { value: Store<L>; set(next: L): void };
}

export type ActiveGame = { gameId: string; round: number; supported: boolean };

export interface GameApi {
  readonly state: {
    readonly active: Store<ActiveGame | undefined>;
    readonly last: Store<LastGame | undefined>;
    readonly round: Store<number | undefined>;
  };
  readonly actions: {
    /** Host. */
    start<T extends GameTypes>(
      def: GameDef<T>,
      settings: T["settings"]
    ): Promise<Result<void, StartReject>>;
    /** Host. */
    end(): Promise<Result<void, EndReject>>;
    /** The same object for the same def. */
    handle<T extends GameTypes>(def: GameDef<T>): GameHandle<T>;
  };
}

// ─── Construction ───────────────────────────────────────────────────────────

/** An `ObservedPlayer` plus the peer, so `sendTo(PlayerId)` can resolve it. A ghost has none. */
export type InputPlayer = ObservedPlayer & { peerId?: PeerId };

/** What the room wires from roster and lobby; game imports neither. */
export type GameInputs = {
  players: Store<readonly InputPlayer[]>;
  /** Players removed on purpose (kick, ban), not merely expired. */
  removed: Listenable<PlayerId>;
  /** What `start` reads, so the setup is never stale. */
  setup: Store<SlotSetup>;
};

export interface GameDeps {
  /** Not started yet: game registers its channels first. */
  bus: Bus;
  clock: Clock;
  entropy: Entropy;
  log: Logger;
  storages: Storages;
  roomId: RoomId;
  localPlayerId: PlayerId;
  /** `transport.role`: host actions answer "not-host" for a guest. */
  role: Store<"guest" | "host">;
  games: readonly RegisteredGame[];
  inputs: GameInputs;
  config: GameConfig;
}
