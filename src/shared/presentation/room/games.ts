// Adding a game = one line in each of the two lists below, plus its page.

import { demoTap } from "@/demo-tap/demo-tap";
import type { RegisteredGame } from "@/shared/application/game";

/** Every game the room client can run. */
export const GAMES: readonly RegisteredGame[] = [demoTap];

/** Sub-route (under /room/[roomId]) that renders each game. */
const GAME_ROUTES: Record<string, string> = {
  [demoTap.id]: "/demo-game",
};

export function gameRoute(gameId: string): string | undefined {
  return GAME_ROUTES[gameId];
}
