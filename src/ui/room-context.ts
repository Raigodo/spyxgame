import { createContext, useContext } from "react";
import type { Room } from "@/room";

export const RoomContext = createContext<Room | undefined>(undefined);

export function useRoom(): Room {
  const room = useContext(RoomContext);
  if (!room) throw new Error("useRoom must be used inside RoomProvider.");
  return room;
}
