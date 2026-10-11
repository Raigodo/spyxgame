import type { GameContext } from "@/shared/application/game";
import type { LobbyConfig, LobbyMode, LobbyModule, LobbyPlayer } from "@/shared/application/lobby";
import type { PlayerPresenceService } from "@/shared/application/presence";
import { Store, structurallyEqual, type Unsubscribe } from "@/shared/kernel";

export interface LobbyInfo {
  mode: LobbyMode;
  teamIds: readonly string[];
  allReady: boolean;
}

export const DEFAULT_LOBBY_INFO: LobbyInfo = { mode: "free-for-all", teamIds: [], allReady: false };

// The client's cached view of who is in the room: players, lobby info, local pending flag.
// Each value keeps a stable reference until it really changes.
export class RosterView {
  private readonly players: Store<LobbyPlayer[]>;
  private readonly lobby: Store<LobbyInfo>;
  private readonly pending: Store<boolean>;

  constructor(onListenerError?: (error: unknown) => void) {
    this.players = new Store<LobbyPlayer[]>([], structurallyEqual, onListenerError);
    this.lobby = new Store<LobbyInfo>(DEFAULT_LOBBY_INFO, structurallyEqual, onListenerError);
    this.pending = new Store<boolean>(false, Object.is, onListenerError);
  }

  getPlayers(): LobbyPlayer[] {
    return this.players.get();
  }
  getLobby(): LobbyInfo {
    return this.lobby.get();
  }
  isPending(): boolean {
    return this.pending.get();
  }

  onPlayersChanged(handler: (players: LobbyPlayer[]) => void): Unsubscribe {
    return this.players.subscribe(handler);
  }
  onLobbyChanged(handler: (lobby: LobbyInfo) => void): Unsubscribe {
    return this.lobby.subscribe(handler);
  }
  onPendingChanged(handler: (pending: boolean) => void): Unsubscribe {
    return this.pending.subscribe(handler);
  }

  /** Re-reads the lobby. Both caches update first, then listeners run. Returns whether the roster changed. */
  refresh(lobby: LobbyModule | undefined): boolean {
    const config = lobby?.getConfig();
    const nextInfo: LobbyInfo =
      lobby && config
        ? {
            mode: config.mode,
            teamIds: config.mode === "teams" ? config.teamIds : [],
            allReady: lobby.areAllPlayersReady(),
          }
        : DEFAULT_LOBBY_INFO;

    const notifyPlayers = this.players.stage(lobby ? lobby.getPlayers() : []);
    const notifyLobby = this.lobby.stage(nextInfo);
    notifyPlayers?.();
    notifyLobby?.();
    return notifyPlayers !== undefined;
  }

  refreshPending(presence: PlayerPresenceService | undefined): void {
    this.pending.set(presence?.isLocalPending() ?? false);
  }

  /** Teardown: back to empty, without notifying (as before). */
  reset(): void {
    this.players.reset([]);
    this.lobby.reset(DEFAULT_LOBBY_INFO);
    this.pending.reset(false);
  }

  /** Who plays, and on which team, frozen for a game start. */
  freezeContext(lobby: LobbyConfig): GameContext {
    const teams: Record<string, string> = {};
    const participants: string[] = [];
    for (const p of this.players.get()) {
      participants.push(p.playerId);
      if (lobby.mode === "teams" && p.teamId) teams[p.playerId] = p.teamId;
    }
    return { lobby, teams, participants };
  }
}
