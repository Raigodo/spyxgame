"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useRoom } from "./room-context";
import { useStore } from "./use-store";

export function RoomNavigator() {
  const room = useRoom();
  const router = useRouter();
  const pathname = usePathname();
  const active = useStore(room.game.state.active);
  const round = useStore(room.game.state.round);

  const target = active?.supported
    ? `/room/${room.roomId}/${active.gameId}`
    : `/room/${room.roomId}`;

  useEffect(() => {
    // `round` is undefined until the game channel has synced: do not bounce a refreshed game page to the lobby.
    if (round !== undefined && pathname !== target) router.replace(target);
  }, [round, pathname, target, router]);

  return null;
}
