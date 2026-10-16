// Each game is one typed definition. Every part that touches the network is
// validated by the game's own validators, and every reducer is a pure function
// so a newly promoted host can keep the game running from replicated state.
//
// Usage: defineGame<Config, State, Commands, Events, Modes>({ ... }) with
// explicit type arguments. Commands and Events are payload maps, declared with
// `type` aliases (not interfaces):
//   type Cmds = { tap: Record<string, never>; move: { from: number; to: number } };

import type { LobbyMode } from "@/shared/application/lobby";
import { createRuntime, type GameRuntime } from "./game-runtime";
import type { BelowMin, PresenceChange, RejoinStrategy } from "./game-presence";
import { Migrate } from "./game-version";
import { WithEffects } from "./game-effects";
import type { PrivateView } from "./game-private";

export interface FreeForAllContext {
  mode: "free-for-all";
  participants: readonly string[];
}

export interface TeamsContext {
  mode: "teams";
  teamIds: readonly string[];
  participants: readonly string[];
  /** playerId -> teamId */
  teams: Readonly<Record<string, string>>;
}

/** The lobby type the game was started from. A game declaring modes ["teams"] gets TeamsContext. */
export type LobbyContext<M extends LobbyMode> = M extends "teams"
  ? TeamsContext
  : FreeForAllContext;

export type CommandAllow = "participant" | "host" | "anyone";

/** What a reducer may ask for besides a new state. */
export type GameEffect<Evs extends object> =
  /** Ends the game: the host runtime returns everyone to the lobby. */
  | { type: "end" }
  /** Starts (or restarts, same id) a timer. `name` must be a key of the spec's `timers`. */
  | { type: "startTimer"; id: string; name: string; afterMs: number; payload?: unknown }
  | { type: "cancelTimer"; id: string }
  /** Records a notice every peer can read (payload checked by the game's `events` validator). */
  | { [K in keyof Evs & string]: { type: "emit"; name: K; data: Evs[K] } }[keyof Evs & string];

export type CommandOutcome<S, Evs extends object, H = unknown> =
  | {
      ok: true;
      state: S;
      effects?: readonly GameEffect<Evs>[];
      /** playerId -> new private piece, or null to remove it. Sent only to its owner. */
      privateState?: Readonly<Record<string, H | null>>;
    }
  | { ok: false; reason: string };

export interface CommandDef<
  C,
  S,
  M extends LobbyMode,
  P,
  Evs extends object = Record<string, never>,
  H = unknown,
> {
  /** Who may send it. Default "participant" (spectators are read-only). */
  allow?: CommandAllow;
  validate(raw: unknown): P | undefined;
  /** Pure. Runs on whichever peer is host. */
  reduce(args: {
    state: S;
    payload: P;
    config: C;
    context: LobbyContext<M>;
    /** playerIds currently marked away. Replicated, so reducers stay pure. */
    away: readonly string[];
    sender: { peerId: string; playerId: string };
    privateState: PrivateView<H>;
  }): CommandOutcome<S, Evs, H>;
}

export interface EventDef<E> {
  validate(raw: unknown): E | undefined;
}

export interface LateJoinDecision<S, H = unknown> {
  /** Required in teams mode, ignored otherwise. */
  team?: string;
  /** Optional new state, e.g. to add the player's entry. */
  state?: S;
  /** Take over the seat of this away participant (must be in `away`). Works at maxPlayers. */
  replaces?: string;
  /** The joiner's private piece. Default: `privateState.initial`. */
  privateState?: H;
}

/** Who is where, as the host sees it. Passed to every presence-related callback. */
export interface RosterInfo {
  /** Participants currently marked away. */
  away: readonly string[];
  /** playerId -> nickname. Includes players who left. */
  names: Readonly<Record<string, string>>;
}

export type RejoinRule<C, S, M extends LobbyMode> =
  | RejoinStrategy
  | ((
      args: RosterInfo & { state: S; config: C; context: LobbyContext<M>; playerId: string }
    ) => RejoinStrategy);

/** Runs on the host when a timer started by a reducer reaches its deadline. Pure, like a reducer. */
export interface TimerDef<
  C,
  S,
  M extends LobbyMode,
  Evs extends object = Record<string, never>,
  H = unknown,
> {
  /** Checks the payload given to startTimer (again when a slot arrives over the network). Return undefined if invalid. Omit for no payload. */
  validate?(raw: unknown): unknown;
  reduce(args: {
    state: S;
    payload: unknown;
    config: C;
    context: LobbyContext<M>;
    away: readonly string[];
    privateState: PrivateView<H>;
  }): CommandOutcome<S, Evs, H>;
}

export interface PresencePolicy<
  C,
  S,
  M extends LobbyMode,
  Evs extends object = Record<string, never>,
  H = unknown,
> {
  /** How long a participant may be missing before they count as away. Default: config.game.awayAfterMs. */
  awayAfterMs?: number;
  /** "restore" (default): a returning player keeps their place. "spectate": they come back as a spectator. A function decides per player. */
  rejoin?: RejoinRule<C, S, M>;
  /**
   * Pure. Runs on the host when players go away, return or are dropped. Return the new state
   * (e.g. skip the away player's turn), or undefined to leave it alone.
   */
  /** Fewer participants than this (not counting away ones) triggers `belowMin`. Default: no minimum. */
  minPresent?: number;
  /**
   * What to do below `minPresent`. "continue" (default): nothing. "pause": non-host commands are
   * rejected until enough players return or the host continues. "end": the host ends the game.
   */
  belowMin?: BelowMin;
  //Return withEffects(state, effects) to also start timers, emit notices or end the game.
  onChange?(
    args: RosterInfo & {
      state: S;
      config: C;
      context: LobbyContext<M>;
      changes: readonly PresenceChange[];
      privateState: PrivateView<H>;
    }
  ): S | WithEffects<S, GameEffect<Evs>, H> | undefined;
}

/** Per-player values only their owner sees. The host can read all of them (it is a browser). */
export interface PrivatePolicy<C, S, M extends LobbyMode, H> {
  /** Network input: a sanitized piece, or undefined to reject. */
  validate(raw: unknown): H | undefined;
  /** A participant's starting piece (slot creation, admitted late joiners). Pure. undefined: none. */
  initial?(args: {
    playerId: string;
    state: S;
    config: C;
    context: LobbyContext<M>;
  }): H | undefined;
  /**
   * Pure. Rebuilds a piece the host lost (failover, host refresh). Make it a function of the
   * replicated state, e.g. derived from a seed. undefined: the piece stays missing.
   */
  recover?(args: {
    playerId: string;
    state: S;
    config: C;
    context: LobbyContext<M>;
    away: readonly string[];
  }): H | undefined;
}

export interface GameSpec<
  C,
  S,
  Cmds extends object,
  Evs extends object,
  M extends LobbyMode,
  H = unknown,
> {
  id: string;
  /** Bump when the shape of config or state changes. Default 1. Stored in every slot. */
  version?: number;
  /** Upgrades an older slot's raw config or state before the validators see it. */
  migrate?: { state?: Migrate; config?: Migrate };
  modes: readonly M[];
  /** Enforced by the host before the game starts. Default 1 and unlimited. */
  minPlayers?: number;
  maxPlayers?: number;

  validateConfig(raw: unknown): C | undefined;
  validateState(raw: unknown): S | undefined;
  initialState(args: { config: C; context: LobbyContext<M> }): S;

  commands: { [K in keyof Cmds & string]: CommandDef<C, S, M, Cmds[K], Evs, H> };
  /** Timer handlers, by name. A reducer starts one with a `startTimer` effect. */
  timers?: { [name: string]: TimerDef<C, S, M, Evs, H> };
  /** Ephemeral traffic: no state, no replay. Also the payload shapes for reducer notices (emit effects). */
  events?: { [K in keyof Evs & string]: EventDef<Evs[K]> };

  /** Late joiners are spectators unless this admits them. Runs once per player, on the host. */
  onLateJoin?(
    args: RosterInfo & {
      state: S;
      config: C;
      context: LobbyContext<M>;
      playerId: string;
    }
  ): LateJoinDecision<S, H> | undefined;

  presence?: PresencePolicy<C, S, M, Evs, H>;
  privateState?: PrivatePolicy<C, S, M, H>;
}

/** What the client registry needs. Non-generic, so definitions of different games fit in one array. */
export interface RegisteredGame {
  readonly id: string;
  readonly runtime: GameRuntime;
}

export interface GameDefinition<
  C,
  S,
  Cmds extends object,
  Evs extends object,
  M extends LobbyMode,
  H = unknown,
> extends RegisteredGame {
  readonly spec: GameSpec<C, S, Cmds, Evs, M, H>;
}

export function defineGame<
  C,
  S,
  Cmds extends object,
  Evs extends object = Record<string, never>,
  M extends LobbyMode = LobbyMode,
  H = unknown,
>(spec: GameSpec<C, S, Cmds, Evs, M, H>): GameDefinition<C, S, Cmds, Evs, M, H> {
  return { id: spec.id, spec, runtime: createRuntime(spec) };
}
