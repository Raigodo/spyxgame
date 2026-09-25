export { LobbyController } from "./lobby-controller";
export type { Lobby, LobbyConfig } from "./lobby-controller";
export { FreeForAllLobbyService } from "./free-for-all-lobby-service";
export { TeamLobbyService } from "./team-lobby-service";
export type { LobbyPlayer, LobbyMode } from "./types";
// LobbyRoster is deliberately not exported — it's shared wiring between the
// two lobby facades, not something consumers should construct directly.
