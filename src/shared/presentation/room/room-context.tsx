// src/shared/presentation/room/room-context.tsx
"use client";

import { createContext, useContext } from "react";
import type { MultiplayerClient } from "@/shared/application/room";

export interface RoomContextValue {
  client: MultiplayerClient;
  roomId: string;
  playerId: string;
  /** Builds an in-room URL that keeps the playerId, e.g. roomHref("/demo-game"). */
  roomHref: (subPath?: string) => string;
}

export const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (!value) throw new Error("useRoom must be used inside <RoomProvider>");
  return value;
}
