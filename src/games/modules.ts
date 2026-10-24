import { DemoTapPage } from "./demo-tap/game-page";
import { DemoTapStarter } from "./demo-tap/starter";
import { demoTap } from "./demo-tap/definition";
import { defineModule, type GameModule } from "./module";
import { SpyPage } from "./spy/game-page";
import { SpyStarter } from "./spy/starter";
import { spyGame } from "./spy/definition";

export const GAME_MODULES: readonly GameModule[] = [
  defineModule({ def: demoTap, label: "Tap race", Starter: DemoTapStarter, Page: DemoTapPage }),
  defineModule({ def: spyGame, label: "Spy", Starter: SpyStarter, Page: SpyPage }),
];

export const findModule = (id: string): GameModule | undefined =>
  GAME_MODULES.find((m) => m.def.id === id);
