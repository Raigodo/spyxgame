import type { PlayerPresenceService } from "@/shared/application/presence";
import type { PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { FreeForAllLobbyService } from "./free-for-all-lobby-service";
import { LobbyPlayerView } from "./lobby-player-view";
import { TeamLobbyService } from "./team-lobby-service";
import type { Lobby, LobbyConfig, LobbyMode, LobbySnapshot } from "./types";

type LobbyControlMessage =
  | { __lobbyControl: true; mode: "free-for-all" }
  | { __lobbyControl: true; mode: "teams"; teamIds: string[] };

type LobbyChangedHandler = (lobby: Lobby) => void;

// Single entry point for lobby features on top of an already-joined
// PlayerSession and a PlayerPresenceService shared with the rest of the
// app's lifetime — it's constructed once elsewhere and keeps running,
// untouched, once the game starts. LobbyController itself never touches
// connection status, reconnects, or duplicate sessions; that's entirely
// PlayerPresenceService's job. This class only owns which lobby "shape" is
// currently active (free-for-all vs teams) and keeps that shape synced
// across every peer, using the same session used for everything else — the
// host can switch shapes at any time without anyone creating a new
// PlayerSession or rejoining the room.
export class LobbyController {
  private readonly players: LobbyPlayerView;
  private lobby: Lobby;
  private readonly changedHandlers = new Set<LobbyChangedHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(
    private readonly session: PlayerSession,
    presence: PlayerPresenceService,
    initialConfig: LobbyConfig = { mode: "free-for-all" }
  ) {
    this.players = new LobbyPlayerView(presence);
    this.lobby = this.createLobby(initialConfig);

    this.cleanupFns.push(
      session.onMessage((payload, from) => this.handleMessage(payload, from)),

      // A peer who joins — or rejoins — after the mode was already switched
      // has no other way to learn the current shape: everyone else learned
      // it at switch time, which already happened. Sourced from the
      // presence-aware roster rather than raw session events, so a
      // newcomer still being arbitrated as a duplicate session doesn't get
      // sent a config it may never need.
      this.players.onPlayerJoined((player) => this.syncModeToNewcomer(player.peerId)),
      this.players.onPlayerRejoined((player) => this.syncModeToNewcomer(player.peerId))
    );
  }

  // Tears down only lobby-owned listeners: the mode-switch protocol and the
  // late-joiner sync. The PlayerPresenceService passed into the constructor
  // is owned by whoever created it and keeps running untouched — reconnects
  // during the game are its job, not this one's, and this class was never
  // in a position to interrupt them even accidentally.
  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
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

  // Passive export — no broadcast, no game-lifecycle opinion. The app reads
  // this, disposes the lobby, and constructs whatever GameController it
  // wants with the same PlayerSession and PlayerPresenceService, both of
  // which are still joined and untouched.
  getSnapshot(): LobbySnapshot {
    const config = this.currentConfig();
    return {
      mode: config.mode,
      teamIds: config.mode === "teams" ? config.teamIds : undefined,
      hostPeerId: this.session.getHostPeerId(),
      localPeerId: this.session.getLocalPlayer()?.peerId,
      players: this.lobby.getPlayers(),
    };
  }

  // Convenience for a "Start" button: snapshot + dispose in one call. Only
  // ever tears down lobby-local listeners (the mode-switch protocol and
  // late-joiner sync) — never PlayerSession, WebRtcService, or
  // PlayerPresenceService, all meant to be reused as-is by whatever comes
  // next, just with new callbacks attached. Unlike switchToTeams /
  // switchToFreeForAll, this is NOT host-gated: every peer, host and guests
  // alike, needs to call this locally when the game actually begins — it's
  // a per-tab teardown, not a network action, so coordinating *when*
  // everyone calls it is the app's job, not this class's.
  startGame(): LobbySnapshot {
    const snapshot = this.getSnapshot();
    this.dispose();
    return snapshot;
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
      ? new TeamLobbyService(this.players, config.teamIds)
      : new FreeForAllLobbyService(this.players);
  }

  private syncModeToNewcomer(peerId: SignalingPeerId): void {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    if (!this.session.isHost() || peerId === localPeerId) return;
    this.session.sendToPlayer(peerId, this.toControlMessage(this.currentConfig()));
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
