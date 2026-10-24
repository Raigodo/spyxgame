// The game feature's public API (zoom-5). Nothing of slot/, host-flow or state is exported.
// fakes.ts is imported directly by tests ("@/game/fakes"), never through this barrel.

export { DEFAULT_GAME_CONFIG } from "./config";
export { createGame } from "./create-game";
export { defineGame } from "./define";
export { defineLocalState } from "./local-state";
export type { GameConfig } from "./config";
export type {
  ActiveGame,
  BelowMin,
  CommandWho,
  ContinueReject,
  Effect,
  EndReject,
  GameApi,
  GameDef,
  GameDeps,
  GameHandle,
  GameInputs,
  GameSpec,
  GameTimer,
  GameTypes,
  GameView,
  InputPlayer,
  LastGame,
  LateDecision,
  LobbyMode,
  LocalStateDef,
  Migrate,
  ModeOf,
  ObservedPlayer,
  Outcome,
  PlayError,
  PlayGateReject,
  PresenceChange,
  PresenceRules,
  PrivateOf,
  PrivateSpec,
  PrivateView,
  ReduceArgs,
  RegisteredGame,
  RejoinStrategy,
  RosterArgs,
  Sender,
  SetupOf,
  SlotSetup,
  StartReject,
  TimerArgs,
  ViewPlayer,
  ViewRole,
} from "./model";
