import type { RegisteredGame } from "@/shared/application/game";

export interface GameEntry {
  definition: RegisteredGame;
  /** Sub-route under /room/[roomId], e.g. "/demo-game". */
  route: string;
}

export interface GameRegistry {
  games: readonly RegisteredGame[];
  gameRoute(gameId: string): string | undefined;
}

// RoomNavigator compares pathname to `/room/${roomId}${route}` literally, so no trailing slash.
const ROUTE = /^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/** Throws on a duplicate id or a malformed route: both are programmer errors, caught at load. */
export function createGameRegistry(entries: readonly GameEntry[]): GameRegistry {
  const routes = new Map<string, string>();
  for (const { definition, route } of entries) {
    if (routes.has(definition.id)) throw new Error(`[games] Duplicate game "${definition.id}".`);
    if (!ROUTE.test(route)) {
      throw new Error(
        `[games] Bad route "${route}" for "${definition.id}": use "/name", no trailing slash.`
      );
    }
    routes.set(definition.id, route);
  }
  return {
    games: entries.map((e) => e.definition),
    gameRoute: (gameId) => routes.get(gameId),
  };
}
