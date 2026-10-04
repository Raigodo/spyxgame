// src/shared/presentation/room/room-navigator.tsx
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

  useEffect(() => {
    if (sub === undefined) return;
    if (pathname !== `/room/${roomId}${sub}`) router.replace(roomHref(sub));
  }, [sub, pathname, roomId, roomHref, router]);

  return null;
}
