// Owns the "room" state channel and its coordination commands. All three are
// host-only and are pure reducers, so a newly promoted host keeps working
// from the replicated state alone.

import type { CommandResult, RoomBus, StateChannel } from "@/shared/application/messaging";
import type { LobbyConfig } from "@/shared/application/lobby";
import {
  INITIAL_ROOM_STATE,
  isRecord,
  sanitizeGameContext,
  sanitizeLobbyConfig,
  sanitizeRoomState,
  type GameContext,
  type RoomState,
} from "./room-state";

export interface RoomStateOptions {
  /** Host-side check for a game start. Return a reason string to reject. */
  validateGame?: (id: string, config: unknown, context: GameContext) => string | undefined;
}

export interface StartGamePayload {
  id: string;
  config: unknown;
  context: GameContext;
}

function parseStartGame(v: unknown): StartGamePayload | undefined {
  if (!isRecord(v) || typeof v.id !== "string" || v.id.length === 0 || v.id.length > 64) {
    return undefined;
  }
  const context = sanitizeGameContext(v.context);
  return context ? { id: v.id, config: v.config ?? null, context } : undefined;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class RoomStateService {
  private readonly channel: StateChannel<RoomState>;

  constructor(bus: RoomBus, options: RoomStateOptions = {}) {
    this.channel = bus.stateChannel<RoomState>({
      id: "room",
      initial: INITIAL_ROOM_STATE,
      validate: sanitizeRoomState,
    });

    this.channel.handle<LobbyConfig>("lobby/switch", {
      hostOnly: true,
      validate: sanitizeLobbyConfig,
      reduce: (state, lobby) =>
        state.phase !== "lobby"
          ? { ok: false, reason: "not-in-lobby" }
          : { ok: true, state: { ...state, lobby } },
    });

    this.channel.handle<StartGamePayload>("room/startGame", {
      hostOnly: true,
      validate: parseStartGame,
      reduce: (state, { id, config, context }) => {
        if (state.phase !== "lobby") return { ok: false, reason: "already-in-game" };
        if (!sameJson(context.lobby, state.lobby)) return { ok: false, reason: "stale-lobby" };
        const invalid = options.validateGame?.(id, config, context);
        if (invalid) return { ok: false, reason: invalid };
        return { ok: true, state: { ...state, phase: "in-game", game: { id, config, context } } };
      },
    });

    this.channel.handle<Record<string, never>>("room/endGame", {
      hostOnly: true,
      validate: () => ({}),
      reduce: (state) =>
        state.phase !== "in-game"
          ? { ok: false, reason: "not-in-game" }
          : { ok: true, state: { phase: "lobby", lobby: state.lobby, round: state.round + 1 } },
    });
  }

  getState(): RoomState {
    return this.channel.get();
  }

  onChange(handler: (state: RoomState, prev: RoomState) => void): () => void {
    return this.channel.onChange(handler);
  }

  switchLobby(config: LobbyConfig): Promise<CommandResult> {
    return this.channel.send("lobby/switch", config);
  }

  startGame(payload: StartGamePayload): Promise<CommandResult> {
    return this.channel.send("room/startGame", payload);
  }

  endGame(): Promise<CommandResult> {
    return this.channel.send("room/endGame", {});
  }
}
