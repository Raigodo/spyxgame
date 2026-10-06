export type { MultiplayerClient } from "./multiplayer-client";
export type { ClientStatus, JoinOptions, JoinResult, LobbyInfo } from "./multiplayer-client";
export type { ActiveGame, GameContext, RoomPhase } from "./room-state";
export type { RoomStateOptions } from "./room-state-service";
// RoomStateService and the sanitizers stay internal.

export type { ChatLine } from "@/shared/application/chat";
export type { ClientOptions } from "./multiplayer-client";

export { createMultiplayerClient } from "./create-multiplayer-client";
export type { MultiplayerClientOverrides } from "./create-multiplayer-client";
export type { ClientDeps } from "./multiplayer-client";
