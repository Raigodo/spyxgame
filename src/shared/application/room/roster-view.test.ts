import { describe, expect, it, vi } from "vitest";
import type { LobbyModule, LobbyPlayer } from "@/shared/application/lobby";
import { DEFAULT_LOBBY_INFO, RosterView } from "./roster-view";

const player = (peerId: string, over: Partial<LobbyPlayer> = {}): LobbyPlayer => ({
  peerId,
  playerId: `pid-${peerId}`,
  nickname: peerId,
  metadata: {},
  connectionStatus: "active",
  returning: false,
  ready: false,
  ...over,
});

const fakeLobby = (players: LobbyPlayer[], teamIds?: string[]) =>
  ({
    getPlayers: () => players,
    getConfig: () => (teamIds ? { mode: "teams", teamIds } : { mode: "free-for-all" }),
    areAllPlayersReady: () => players.length > 0 && players.every((p) => p.ready),
  }) as unknown as LobbyModule;

describe("RosterView", () => {
  it("keeps references and stays silent when nothing changed", () => {
    const view = new RosterView();
    const seen = vi.fn();
    view.onPlayersChanged(seen);
    expect(view.refresh(fakeLobby([player("a")]))).toBe(true);
    const first = view.getPlayers();
    expect(view.refresh(fakeLobby([player("a")]))).toBe(false);
    expect(view.getPlayers()).toBe(first);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("a players listener already sees the fresh lobby info", () => {
    const view = new RosterView();
    let lobbyInListener: unknown;
    view.onPlayersChanged(() => (lobbyInListener = view.getLobby()));
    view.refresh(fakeLobby([player("a", { ready: true })], ["red", "blue"]));
    expect(lobbyInListener).toEqual({ mode: "teams", teamIds: ["red", "blue"], allReady: true });
  });

  it("reset empties silently, and refresh with no lobby gives defaults", () => {
    const view = new RosterView();
    view.refresh(fakeLobby([player("a")]));
    const seen = vi.fn();
    view.onPlayersChanged(seen);
    view.reset();
    expect(view.getPlayers()).toEqual([]);
    expect(view.getLobby()).toBe(DEFAULT_LOBBY_INFO);
    expect(seen).not.toHaveBeenCalled();
  });

  it("freezes participants, and teams only in teams mode", () => {
    const view = new RosterView();
    view.refresh(fakeLobby([player("a", { teamId: "red" }), player("b")]));
    expect(view.freezeContext({ mode: "teams", teamIds: ["red", "blue"] })).toEqual({
      lobby: { mode: "teams", teamIds: ["red", "blue"] },
      teams: { "pid-a": "red" },
      participants: ["pid-a", "pid-b"],
    });
    expect(view.freezeContext({ mode: "free-for-all" }).teams).toEqual({});
  });
});
