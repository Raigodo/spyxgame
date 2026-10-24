import type { GameDef, GameTypes } from "@/game";
import { useRoom } from "./room-context";
import { useStore } from "./use-store";

/** One game's handle and its atomic view (undefined until that game is active and synced). */
export function useGame<T extends GameTypes>(def: GameDef<T>) {
  const room = useRoom();
  const handle = room.game.actions.handle(def);
  const view = useStore(handle.view);
  return { room, handle, view };
}
