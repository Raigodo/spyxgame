"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { createMultiplayerClient, type MultiplayerClient } from "@/shared/application/room";
import { GAMES } from "./games";
import { RoomContext, useRoom, type RoomContextValue } from "./room-context";
import { usePhase, useRoomStatus } from "./room-hooks";
import { installDebugHook } from "./debug-hook";
import { configWithIceServers, fetchIceServers } from "./ice-servers";
import { RoomNavigator } from "./room-navigator";

// Pages keep importing useRoom from here.
export { useRoom };

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="bg-slate-950 p-6 min-h-screen text-slate-200">
      {children}
      <div className="mt-4">
        <Link href="/room" className="text-indigo-400 underline">
          Back to rooms
        </Link>
      </div>
    </div>
  );
}

// Renders children once the room state has synced for the first time. After
// that it never unmounts them: a host change shows a banner instead.
function RoomShell({ children }: { children: ReactNode }) {
  const phase = usePhase();
  const status = useRoomStatus();

  if (phase === undefined) return <Message>Syncing room…</Message>;
  return (
    <>
      <RoomNavigator />
      {status === "syncing" && (
        <div className="top-0 right-0 left-0 z-50 fixed bg-amber-950 p-2 border-amber-800 border-b text-amber-300 text-sm text-center">
          Reconnecting…
        </div>
      )}
      {children}
    </>
  );
}

// Owns one MultiplayerClient per room: join on mount, leave on unmount.
export function RoomProvider({ children }: { children: ReactNode }) {
  const { roomId } = useParams<{ roomId: string }>();
  // Captured once. We write a generated id back into the URL below, and that
  // must not re-trigger the join effect.
  const searchParams = useSearchParams();
  const [initialPlayerId] = useState(() => searchParams.get("playerId") ?? undefined);
  const [value, setValue] = useState<RoomContextValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);
  const [kicked, setKicked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let client: MultiplayerClient | undefined;
    let unsubscribers: Array<() => void> = [];

    // Deferred a tick so React StrictMode's mount → cleanup → mount in dev
    // never starts two joins with the same playerId (which would trigger
    // duplicate-session arbitration against yourself).
    const timer = setTimeout(async () => {
      // Relay servers first: the client reads its ICE servers when it is created.
      const iceServers = await fetchIceServers();
      if (cancelled) return;

      const created = createMultiplayerClient(
        { games: GAMES },
        { config: configWithIceServers(iceServers) }
      );
      client = created;
      // Subscribed before joining, so a supersede during the join is never missed.
      unsubscribers = [
        created.onSuperseded(() => setSuperseded(true)),
        created.onKicked(() => setKicked(true)),
        process.env.NODE_ENV === "production" ? () => {} : installDebugHook(created),
      ];

      try {
        const { playerId, generated } = await created.join({
          roomId,
          playerId: initialPlayerId,
        });
        if (cancelled) return;

        if (generated) {
          const url = new URL(window.location.href);
          url.searchParams.set("playerId", playerId);
          window.history.replaceState(null, "", url);
        }

        setValue({
          client: created,
          roomId,
          playerId,
          roomHref: (sub = "") => `/room/${roomId}${sub}?playerId=${playerId}`,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to join room.");
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const off of unsubscribers) off();
      setKicked(false);
      setValue(null);
      setError(null);
      setSuperseded(false);
      void client?.leave(); // idempotent; safe if the join never started
    };
  }, [roomId, initialPlayerId]);

  if (error) return <Message>Couldn&apos;t join: {error}</Message>;

  if (superseded)
    return <Message>This tab was disconnected: a newer connection took over.</Message>;

  if (kicked) return <Message>You were removed from the room by the host.</Message>;

  if (!value) return <Message>Connecting…</Message>;

  return (
    <RoomContext.Provider value={value}>
      <RoomShell>{children}</RoomShell>
    </RoomContext.Provider>
  );
}
