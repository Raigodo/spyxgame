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
  MultiplayerClient,
  RoomPhase,
} from "@/shared/application/room";
import { useRoom } from "./room-context";

const NO_PLAYERS: LobbyPlayer[] = [];

/** One client value: `subscribe` is its `on…` callback, `get` its getter, `server` the SSR value. */
function useClientValue<T>(
  subscribe: (client: MultiplayerClient, notify: () => void) => () => void,
  get: (client: MultiplayerClient) => T,
  server: (client: MultiplayerClient) => T
): T {
  const { client } = useRoom();
  return useSyncExternalStore(
    (notify) => subscribe(client, notify),
    () => get(client),
    () => server(client)
  );
}

export function useRoomStatus(): ClientStatus {
  return useClientValue(
    (c, n) => c.onStatusChanged(n),
    (c) => c.getStatus(),
    () => "idle" as const
  );
}

/** Undefined until the room state has synced once. */
export function usePhase(): RoomPhase | undefined {
  return useClientValue(
    (c, n) => c.onPhaseChanged(n),
    (c) => c.getPhase(),
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
  return useClientValue(
    (c, n) => c.onPendingChanged(n),
    (c) => c.isLocalPending(),
    () => false
  );
}

export function usePlayers(): LobbyPlayer[] {
  return useClientValue(
    (c, n) => c.onPlayersChanged(n),
    (c) => c.getPlayers(),
    () => NO_PLAYERS
  );
}

export function useLobby(): LobbyInfo {
  return useClientValue(
    (c, n) => c.onLobbyChanged(n),
    (c) => c.getLobby(),
    (c) => c.getLobby()
  );
}

export function useActiveGame(): ActiveGame | undefined {
  return useClientValue(
    (c, n) => c.onGameChanged(n),
    (c) => c.getActiveGame(),
    () => undefined
  );
}

export function useChat(): readonly ChatLine[] {
  return useClientValue(
    (c, n) => c.onChatMessage(n),
    (c) => c.getChat(),
    (c) => c.getChat()
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
