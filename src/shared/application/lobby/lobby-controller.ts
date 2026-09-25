import type { PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { FreeForAllLobbyService } from "./free-for-all-lobby-service";
import { LobbyRoster } from "./lobby-roster";
import { TeamLobbyService } from "./team-lobby-service";
import type { LobbyMode } from "./types";

export type Lobby = FreeForAllLobbyService | TeamLobbyService;

export type LobbyConfig = { mode: "free-for-all" } | { mode: "teams"; teamIds: string[] };

type LobbyControlMessage =
  | { __lobbyControl: true; mode: "free-for-all" }
  | { __lobbyControl: true; mode: "teams"; teamIds: string[] };

type LobbyChangedHandler = (lobby: Lobby) => void;

// Single entry point for lobby features on top of an already-joined
// PlayerSession. Owns which lobby "shape" is currently active and keeps it
// synced across every peer via the same session used for everything else —
// the host can switch shapes at any time without anyone creating a new
// PlayerSession or rejoining the room.
export class LobbyController {
  private readonly roster: LobbyRoster;
  private lobby: Lobby;
  private readonly changedHandlers = new Set<LobbyChangedHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(
    private readonly session: PlayerSession,
    initialConfig: LobbyConfig = { mode: "free-for-all" }
  ) {
    this.roster = new LobbyRoster(session);
    this.lobby = this.createLobby(initialConfig);

    this.cleanupFns.push(
      session.onMessage((payload, from) => this.handleMessage(payload, from)),

      // A peer who joins after the mode was already switched has no other
      // way to learn the current shape — everyone else learned it at
      // switch time, which already happened.
      session.onPlayerJoined((player) => {
        const localPeerId = session.getLocalPlayer()?.peerId;
        if (!session.isHost() || player.peerId === localPeerId) return;
        session.sendToPlayer(player.peerId, this.toControlMessage(this.currentConfig()));
      })
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    this.roster.dispose();
  }

  getMode(): LobbyMode {
    return this.lobby.mode;
  }

  getLobby(): Lobby {
    return this.lobby;
  }

  onModeChanged(handler: LobbyChangedHandler): () => void {
    this.changedHandlers.add(handler);
    return () => this.changedHandlers.delete(handler);
  }

  switchToFreeForAll(): void {
    this.applyModeSwitch({ mode: "free-for-all" }, true);
  }

  switchToTeams(teamIds: string[]): void {
    this.applyModeSwitch({ mode: "teams", teamIds }, true);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private currentConfig(): LobbyConfig {
    return this.lobby.mode === "teams"
      ? { mode: "teams", teamIds: [...this.lobby.getTeams()] }
      : { mode: "free-for-all" };
  }

  private applyModeSwitch(config: LobbyConfig, isLocalRequest: boolean): void {
    if (isLocalRequest && !this.session.isHost()) {
      throw new Error("[LobbyController] Only the host can change the lobby mode.");
    }

    this.lobby = this.createLobby(config);

    if (isLocalRequest) {
      this.session.broadcast(this.toControlMessage(config));
    }

    for (const handler of this.changedHandlers) handler(this.lobby);
  }

  private createLobby(config: LobbyConfig): Lobby {
    return config.mode === "teams"
      ? new TeamLobbyService(this.roster, config.teamIds)
      : new FreeForAllLobbyService(this.roster);
  }

  private toControlMessage(config: LobbyConfig): LobbyControlMessage {
    return config.mode === "teams"
      ? { __lobbyControl: true, mode: "teams", teamIds: config.teamIds }
      : { __lobbyControl: true, mode: "free-for-all" };
  }

  private handleMessage(payload: unknown, from: SignalingPeerId): void {
    if (!this.isLobbyControlMessage(payload)) return;

    // This is our own switch echoing back — the host has no direct RTC link
    // to itself, so PlayerSession delivers its own broadcasts locally too.
    // We already applied it synchronously before broadcasting; reapplying
    // here would just recreate the facade for nothing and double-fire
    // onModeChanged.
    if (from === this.session.getLocalPlayer()?.peerId) return;

    // Only the host is a legitimate source of a mode change — without this,
    // any guest could broadcast this message and flip everyone's lobby.
    if (from !== this.session.getHostPeerId()) {
      console.warn("[LobbyController] Ignoring lobby-mode change from non-host peer", from);
      return;
    }

    try {
      const config: LobbyConfig =
        payload.mode === "teams"
          ? { mode: "teams", teamIds: payload.teamIds }
          : { mode: "free-for-all" };
      this.applyModeSwitch(config, false);
    } catch (error) {
      // e.g. a malformed teamIds list — don't let it break other
      // subscribers sharing this same onMessage dispatch.
      console.warn("[LobbyController] Failed to apply incoming lobby-mode change", error);
    }
  }

  private isLobbyControlMessage(value: unknown): value is LobbyControlMessage {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).__lobbyControl === true
    );
  }
}
