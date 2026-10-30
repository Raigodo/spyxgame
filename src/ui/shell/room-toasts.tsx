"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useRoom } from "../room-context";

/** Quiet, passing news from the roster: someone joined, came back, left, or took the host seat. Never about you. */
export function RoomToasts() {
  const room = useRoom();

  useEffect(() => {
    const { events, state } = room.roster;
    const stops = [
      events.joined.on((p) => {
        if (p.presence !== "self") toast(`${p.name} joined`);
      }),
      events.rejoined.on((p) => {
        if (p.presence !== "self") toast(`${p.name} is back`);
      }),
      events.left.on(({ player, reason }) => {
        if (player.presence !== "self") {
          toast(reason === "removed" ? `${player.name} was removed` : `${player.name} left`);
        }
      }),
    ];

    // The seat can be empty for a moment during a failover: remember the last real host, not the last value.
    let hostId = state.host.get()?.id;
    stops.push(
      state.host.subscribe((host) => {
        if (!host) return;
        if (hostId !== undefined && host.id !== hostId) {
          toast(host.presence === "self" ? "You are now the host" : `${host.name} is now the host`);
        }
        hostId = host.id;
      })
    );

    return () => stops.forEach((stop) => stop());
  }, [room]);

  return null;
}
