"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getRoomDeps } from "@/compose";
import { as, type PlayerId, type RoomId } from "@/kernel";
import { joinRoom, type Room } from "@/room";
import { RoomContext } from "./room-context";
import { ConnectingNotice, JoinFailedNotice, RoomEndedNotice } from "./room-status";
import { useStore } from "./use-store";

type Phase = { kind: "connecting" } | { kind: "failed" } | { kind: "ready"; room: Room };

const PLAYER_KEY = "player-id:";

function ReadyRoom({ room, children }: { room: Room; children: ReactNode }) {
  const ended = useStore(room.ended);
  if (ended) return <RoomEndedNotice reason={ended.reason} />;
  return <RoomContext value={room}>{children}</RoomContext>;
}

export function RoomProvider({ roomId, children }: { roomId: string; children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });

  useEffect(() => {
    let cancelled = false;
    let joined: Room | undefined;

    // One tick of delay: StrictMode runs the effect twice in dev, the first run is cancelled before it joins.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const deps = getRoomDeps();
          const key = PLAYER_KEY + roomId;
          const saved = deps.storages.tab.get(key); // per tab: a refresh keeps the player, a new tab is a new one
          const result = await joinRoom(deps, {
            roomId: as<RoomId>(roomId),
            ...(saved !== undefined && { playerId: as<PlayerId>(saved) }),
          });
          if (!result.ok) {
            if (!cancelled) setPhase({ kind: "failed" });
            return;
          }
          const { room } = result.value;
          if (cancelled) {
            void room.leave();
            return;
          }
          deps.storages.tab.set(key, room.playerId);
          joined = room;
          setPhase({ kind: "ready", room });
        } catch {
          if (!cancelled) setPhase({ kind: "failed" });
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      void joined?.leave();
    };
  }, [roomId]);

  if (phase.kind === "connecting") return <ConnectingNotice />;
  if (phase.kind === "failed") return <JoinFailedNotice />;
  return <ReadyRoom room={phase.room}>{children}</ReadyRoom>;
}
