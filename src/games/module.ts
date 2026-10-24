import type { ComponentType } from "react";
import type { GameDef, GameTypes, StartReject } from "@/game";
import type { Result } from "@/kernel";

export interface StarterProps<T extends GameTypes = GameTypes> {
  disabled: boolean;
  start(settings: T["settings"]): Promise<Result<void, StartReject>>;
}

/** A game with its types erased, so different games sit in one array. */
export interface GameModule {
  readonly def: GameDef;
  readonly label: string;
  readonly Starter: ComponentType<StarterProps>;
  readonly Page: ComponentType;
}

export function defineModule<T extends GameTypes>(m: {
  def: GameDef<T>;
  label: string;
  Starter: ComponentType<StarterProps<T>>;
  Page: ComponentType;
}): GameModule {
  return m as unknown as GameModule;
}
