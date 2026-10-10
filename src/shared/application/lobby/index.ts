export { buildLocalProfileInput } from "./build-local-profile";
export { LobbyModule } from "./lobby-module";
export { sanitizeLobbyConfig } from "./lobby-config";
export type { LobbyConfig, LobbyMode, LobbyPlayer, LobbySnapshot } from "./types";
// LobbyPlayerView stays internal — it's wiring, not API.
