// The only React-specific glue: each hook is one useSyncExternalStore over a
// client getter and its matching callback. No logic lives here.
"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { GameDefinition } from "@/shared/application/game";
import type { LobbyMode, LobbyPlayer } from "@/shared/application/lobby";
import type {
  ActiveGame,
  ChatLine,
  ClientStatus,
  LobbyInfo,
  RoomPhase,
} from "@/shared/application/room";
import { useRoom } from "./room-context";

const NO_PLAYERS: LobbyPlayer[] = [];

export function useRoomStatus(): ClientStatus {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => client.onStatusChanged(notify),
    () => client.getStatus(),
    () => "idle" as const
  );
}

/** Undefined until the room state has synced once. */
export function usePhase(): RoomPhase | undefined {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => client.onPhaseChanged(notify),
    () => client.getPhase(),
    () => undefined
  );
}

export function useIsHost(): boolean {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => {
      const offs = [client.onHostChanged(notify), client.onStatusChanged(notify)];
      return () => offs.forEach((off) => off());
    },
    () => client.isHost(),
    () => false
  );
}

export function usePending(): boolean {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => client.onPendingChanged(notify),
    () => client.isLocalPending(),
    () => false
  );
}

export function usePlayers(): LobbyPlayer[] {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => client.onPlayersChanged(notify),
    () => client.getPlayers(),
    () => NO_PLAYERS
  );
}

export function useLobby(): LobbyInfo {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => client.onLobbyChanged(notify),
    () => client.getLobby(),
    () => client.getLobby()
  );
}

export function useActiveGame(): ActiveGame | undefined {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => client.onGameChanged(notify),
    () => client.getActiveGame(),
    () => undefined
  );
}

export function useChat(): readonly ChatLine[] {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => client.onChatMessage(notify),
    () => client.getChat(),
    () => client.getChat()
  );
}

// ─── Games ──────────────────────────────────────────────────────────────────

/** The typed handle for a registered game (the same object on every call). */
export function useGameHandle<C, S, Cmds extends object, Evs extends object, M extends LobbyMode>(
  game: GameDefinition<C, S, Cmds, Evs, M>
) {
  const { client } = useRoom();
  return client.getGame(game);
}

/**
 * Subscribes to any change of a game's slot and reads one value from the handle,
 * e.g. useGameValue(game, () => game.getState()). `get` must return a stable
 * reference between changes (all handle getters do).
 */
export function useGameValue<T>(
  handle: { onChanged(handler: () => void): () => void },
  get: () => T
): T {
  const subscribe = useCallback((notify: () => void) => handle.onChanged(notify), [handle]);
  return useSyncExternalStore(subscribe, get, get);
}
