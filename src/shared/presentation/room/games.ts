// Adding a game = one entry below, plus its page at app/room/[roomId]<route>/page.tsx.

import { demoTap } from "@/demo-tap/demo-tap";
import { createGameRegistry } from "./game-registry";

const registry = createGameRegistry([{ definition: demoTap, route: "/demo-game" }]);

/** Every game the room client can run. */
export const GAMES = registry.games;

/** Sub-route (under /room/[roomId]) that renders a game, if this client knows it. */
export const gameRoute = registry.gameRoute;
