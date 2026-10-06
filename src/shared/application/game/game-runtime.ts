// Turns a typed GameSpec into a non-generic GameRuntime. The registry, the
// client and the host reconciler only ever see GameRuntime, so heterogeneous
// games can sit in one map without `any`.

import type { LobbyConfig, LobbyMode } from "@/shared/application/lobby";
import type { StateChannel } from "@/shared/application/messaging";
import {
  isRecord,
  sanitizeLobbyConfig,
  type GameContext,
} from "@/shared/application/room/room-state";
import type { CommandDef, EventDef, GameSpec, LobbyContext } from "./game-definition";

/** The replicated value of a game channel while a game runs. */
export interface Slot {
  /** Matches RoomState.round. A slot from another round is stale. */
  round: number;
  config: unknown;
  lobby: LobbyConfig;
  participants: string[];
  /** Late joiners who were decided on (admitted ones are in participants). Stops a new host re-deciding. */
  spectators: string[];
  /** playerId -> teamId, only in teams mode. */
  teams: Record<string, string>;
  state: unknown;
}

export type SlotValue = Slot | null;

export interface GameRuntime {
  readonly id: string;
  /** Host-side check before a game may start. Returns a reason to reject. */
  checkStart(config: unknown, lobby: LobbyConfig, playerCount: number): string | undefined;
  createSlot(round: number, config: unknown, context: GameContext): Slot;
  /** null is a valid value (no game running). undefined means invalid. */
  validateSlot(raw: unknown): SlotValue | undefined;
  /** Returns the validated data, or undefined if invalid. */
  validateEvent(name: string, data: unknown): unknown;
  installCommands(channel: StateChannel<SlotValue>): void;
  lateJoin(slot: Slot, playerId: string): Slot;
}

export function toLobbyContext<M extends LobbyMode>(slot: Slot): LobbyContext<M> {
  const context =
    slot.lobby.mode === "teams"
      ? {
          mode: "teams" as const,
          teamIds: slot.lobby.teamIds,
          participants: slot.participants,
          teams: slot.teams,
        }
      : { mode: "free-for-all" as const, participants: slot.participants };
  // Safe: startGame is rejected unless the lobby mode is one of spec.modes.
  return context as unknown as LobbyContext<M>;
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

export function createRuntime<C, S, Cmds extends object, Evs extends object, M extends LobbyMode>(
  spec: GameSpec<C, S, Cmds, Evs, M>
): GameRuntime {
  const modes: readonly LobbyMode[] = spec.modes;
  const minPlayers = spec.minPlayers ?? 1;
  const maxPlayers = spec.maxPlayers ?? Number.POSITIVE_INFINITY;
  const commands = spec.commands as unknown as Record<string, CommandDef<C, S, M, unknown>>;
  const events = spec.events as unknown as Record<string, EventDef<unknown>> | undefined;

  return {
    id: spec.id,

    checkStart(config, lobby, playerCount) {
      if (!modes.includes(lobby.mode)) return `unsupported-mode:${lobby.mode}`;
      if (playerCount < minPlayers) return "too-few-players";
      if (playerCount > maxPlayers) return "too-many-players";
      return spec.validateConfig(config) === undefined ? "invalid-config" : undefined;
    },

    createSlot(round, config, context) {
      const validConfig = spec.validateConfig(config);
      if (validConfig === undefined)
        throw new Error(`[${spec.id}] Invalid config at slot creation.`);
      const base: Slot = {
        round,
        config: validConfig,
        lobby: context.lobby,
        participants: [...context.participants],
        spectators: [],
        teams: { ...context.teams },
        state: null,
      };
      return {
        ...base,
        state: spec.initialState({ config: validConfig, context: toLobbyContext<M>(base) }),
      };
    },

    validateSlot(raw) {
      if (raw === null) return null;
      if (!isRecord(raw) || typeof raw.round !== "number" || !Number.isInteger(raw.round))
        return undefined;
      const lobby = sanitizeLobbyConfig(raw.lobby);
      const config = spec.validateConfig(raw.config);
      const state = spec.validateState(raw.state);
      const participants = strings(raw.participants);
      const spectators = strings(raw.spectators);
      if (!lobby || config === undefined || state === undefined) return undefined;
      if (!participants || !spectators || !isRecord(raw.teams)) return undefined;

      const teams: Record<string, string> = {};
      for (const [playerId, teamId] of Object.entries(raw.teams)) {
        if (typeof teamId === "string") teams[playerId] = teamId;
      }
      return { round: raw.round, config, lobby, participants, spectators, teams, state };
    },

    validateEvent(name, data) {
      return events?.[name]?.validate(data);
    },

    installCommands(channel) {
      for (const [name, def] of Object.entries(commands)) {
        channel.handle<unknown>(name, {
          validate: (raw) => def.validate(raw),
          authorize: ({ state, isHostSender, playerId }) => {
            if (!state) return "no-active-game";
            const allow = def.allow ?? "participant";
            if (allow === "host") return isHostSender ? undefined : "host-only";
            if (allow === "participant") {
              return playerId !== undefined && state.participants.includes(playerId)
                ? undefined
                : "not-a-participant";
            }
            return undefined;
          },
          reduce: (slot, payload, { from, playerId }) => {
            if (!slot) return { ok: false, reason: "no-active-game" };
            if (playerId === undefined) return { ok: false, reason: "unknown-sender" };
            const out = def.reduce({
              state: slot.state as S,
              payload,
              config: slot.config as C,
              context: toLobbyContext<M>(slot),
              sender: { peerId: from, playerId },
            });
            return out.ok ? { ok: true, state: { ...slot, state: out.state } } : out;
          },
        });
      }
    },

    lateJoin(slot, playerId) {
      const spectate: Slot = { ...slot, spectators: [...slot.spectators, playerId] };
      if (!spec.onLateJoin || slot.participants.length >= maxPlayers) return spectate;

      const decision = spec.onLateJoin({
        state: slot.state as S,
        config: slot.config as C,
        context: toLobbyContext<M>(slot),
        playerId,
      });
      if (!decision) return spectate;

      let teams = slot.teams;
      if (slot.lobby.mode === "teams") {
        if (!decision.team || !slot.lobby.teamIds.includes(decision.team)) return spectate;
        teams = { ...slot.teams, [playerId]: decision.team };
      }
      return {
        ...slot,
        participants: [...slot.participants, playerId],
        teams,
        state: decision.state !== undefined ? decision.state : slot.state,
      };
    },
  };
}
