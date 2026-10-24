// The React-free list of game definitions: what room/compose hands to `createGame` (`deps.games`).
// Adding a game is a folder plus one line here. The ui layer's module registry (labels, Starter,
// Page) is built in task 7 on top of these definitions.

import type { RegisteredGame } from "@/game";
import { demoTap } from "./demo-tap/definition";
import { spyGame } from "./spy/definition";

export const GAME_DEFS: readonly RegisteredGame[] = [demoTap, spyGame];
