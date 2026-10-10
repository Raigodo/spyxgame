// The one place that navigates because of room state. Pages never decide where
// the room is: they render whatever route they are on, and this follows the
// client's phase and active game.
"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { gameRoute } from "./games";
import { useActiveGame, usePhase } from "./room-hooks";
import { useRoom } from "./room-context";

export function RoomNavigator() {
  const router = useRouter();
  const pathname = usePathname();
  const { roomId, roomHref } = useRoom();
  const phase = usePhase();
  const game = useActiveGame();

  // undefined = nothing to enforce (not synced yet, or a game with no registered route)
  const sub = phase === "lobby" ? "" : phase === "in-game" && game ? gameRoute(game.id) : undefined;

  // The room runs a game this client has no route for (e.g. a newer client version started it).
  const gameId = game?.id;
  const unroutable = phase === "in-game" && gameId !== undefined && sub === undefined;
  useEffect(() => {
    if (unroutable && process.env.NODE_ENV !== "production") {
      console.warn(`[RoomNavigator] No route registered for game "${gameId}". See games.ts.`);
    }
  }, [unroutable, gameId]);

  useEffect(() => {
    if (sub === undefined) return;
    if (pathname !== `/room/${roomId}${sub}`) router.replace(roomHref(sub));
  }, [sub, pathname, roomId, roomHref, router]);

  return null;
}
