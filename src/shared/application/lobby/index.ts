export { buildLocalProfileInput } from "./build-local-profile";
export { LobbyModule } from "./lobby-module";
export type { FreeForAllLobbyService } from "./free-for-all-lobby-service";
export type { TeamLobbyService } from "./team-lobby-service";
export type { Lobby, LobbyConfig, LobbyMode, LobbyPlayer, LobbySnapshot } from "./types";
// LobbyPlayerView stays internal — it's wiring, not API.
