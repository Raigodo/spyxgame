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
  LastGame,
  LobbyInfo,
  MultiplayerClient,
  RoomPhase,
  RoomPlayer,
} from "@/shared/application/room";
import { useRoom } from "./room-context";

const NO_PLAYERS: RoomPlayer[] = [];

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

export function usePlayers(): RoomPlayer[] {
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
export function useGameHandle<
  C,
  S,
  Cmds extends object,
  Evs extends object,
  M extends LobbyMode,
  H = unknown,
>(game: GameDefinition<C, S, Cmds, Evs, M>) {
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

export function useLastGame(): LastGame | undefined {
  return useClientValue(
    (c, n) => c.onGameChanged(n),
    (c) => c.getLastGame(),
    () => undefined
  );
}

const TICK_MS = 250;
function subscribeTicks(notify: () => void): () => void {
  const handle = setInterval(notify, TICK_MS);
  return () => clearInterval(handle);
}
const currentTick = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

/** Milliseconds left on a game timer (display only, redraws every 250ms). Frozen while paused. */
export function useCountdown(
  timer: { deadlineAt: number; paused: boolean; remainingMs?: number } | undefined
): number | undefined {
  const now = useSyncExternalStore(subscribeTicks, currentTick, () => 0);
  if (!timer) return undefined;
  return timer.paused ? timer.remainingMs : Math.max(0, timer.deadlineAt - now);
}
