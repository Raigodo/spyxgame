// application/game/game-definition.ts
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

export interface CommandDef<C, S, M extends LobbyMode, P> {
  /** Who may send it. Default "participant" (spectators are read-only). */
  allow?: CommandAllow;
  validate(raw: unknown): P | undefined;
  /** Pure. Runs on whichever peer is host. */
  reduce(args: {
    state: S;
    payload: P;
    config: C;
    context: LobbyContext<M>;
    sender: { peerId: string; playerId: string };
  }): { ok: true; state: S } | { ok: false; reason: string };
}

export interface EventDef<E> {
  validate(raw: unknown): E | undefined;
}

export interface LateJoinDecision<S> {
  /** Required in teams mode, ignored otherwise. */
  team?: string;
  /** Optional new state, e.g. to add the player's entry. */
  state?: S;
}

export interface GameSpec<C, S, Cmds extends object, Evs extends object, M extends LobbyMode> {
  id: string;
  modes: readonly M[];
  /** Enforced by the host before the game starts. Default 1 and unlimited. */
  minPlayers?: number;
  maxPlayers?: number;

  validateConfig(raw: unknown): C | undefined;
  validateState(raw: unknown): S | undefined;
  initialState(args: { config: C; context: LobbyContext<M> }): S;

  commands: { [K in keyof Cmds & string]: CommandDef<C, S, M, Cmds[K]> };
  /** Ephemeral traffic: no state, no replay. */
  events?: { [K in keyof Evs & string]: EventDef<Evs[K]> };

  /** Late joiners are spectators unless this admits them. Runs once per player, on the host. */
  onLateJoin?(args: {
    state: S;
    config: C;
    context: LobbyContext<M>;
    playerId: string;
  }): LateJoinDecision<S> | undefined;
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
> extends RegisteredGame {
  readonly spec: GameSpec<C, S, Cmds, Evs, M>;
}

export function defineGame<
  C,
  S,
  Cmds extends object,
  Evs extends object = Record<string, never>,
  M extends LobbyMode = LobbyMode,
>(spec: GameSpec<C, S, Cmds, Evs, M>): GameDefinition<C, S, Cmds, Evs, M> {
  return { id: spec.id, spec, runtime: createRuntime(spec) };
}
