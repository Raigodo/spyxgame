import { describe, expect, it, vi } from "vitest";
import type { PlayerPresenceService, RosterPlayer } from "@/shared/application/presence";
import { LobbyModule } from "./lobby-module";

const roster = (peerId: string, metadata: Record<string, unknown>): RosterPlayer => ({
  peerId,
  playerId: peerId,
  nickname: peerId,
  metadata,
  connectionStatus: "active",
  returning: false,
});

function setup(players: RosterPlayer[], round = 1) {
  const setLocalMetadata = vi.fn();
  const presence = {
    getPlayers: () => players,
    getLocalPlayer: () => players[0],
    setLocalMetadata,
    setNickname: vi.fn(),
  } as unknown as PlayerPresenceService;
  return { lobby: new LobbyModule(presence, () => round), setLocalMetadata };
}

describe("LobbyModule", () => {
  it("projects ready from the current round and drops a team outside teams mode", () => {
    const { lobby } = setup([
      roster("a", { readyRound: 1, teamId: "red" }),
      roster("b", { readyRound: 0 }),
    ]);
    expect(lobby.getPlayers().map((p) => [p.ready, p.teamId])).toEqual([
      [true, undefined],
      [false, undefined],
    ]);
    expect(lobby.areAllPlayersReady()).toBe(false);
  });

  it("applyConfig switches mode in place: teams become visible, then disappear again", () => {
    const { lobby } = setup([roster("a", { teamId: "red" })]);
    lobby.applyConfig({ mode: "teams", teamIds: ["red", "blue"] });
    expect(lobby.getPlayers()[0]?.teamId).toBe("red");
    lobby.applyConfig({ mode: "free-for-all" });
    expect(lobby.getPlayers()[0]?.teamId).toBeUndefined();
  });

  it("chooseTeam writes metadata in teams mode and throws otherwise", () => {
    const { lobby, setLocalMetadata } = setup([roster("a", {})]);
    expect(() => lobby.chooseTeam("red")).toThrow(/not in teams mode/);
    lobby.applyConfig({ mode: "teams", teamIds: ["red", "blue"] });
    expect(() => lobby.chooseTeam("green")).toThrow(/Unknown team/);
    lobby.chooseTeam("red");
    expect(setLocalMetadata).toHaveBeenCalledWith({ teamId: "red" });
  });

  it("leaveTeam clears the team in teams mode and does nothing in free-for-all", () => {
    const { lobby, setLocalMetadata } = setup([roster("a", {})]);
    lobby.leaveTeam();
    expect(setLocalMetadata).not.toHaveBeenCalled();
    lobby.applyConfig({ mode: "teams", teamIds: ["red", "blue"] });
    lobby.leaveTeam();
    expect(setLocalMetadata).toHaveBeenCalledWith({ teamId: null });
  });
});
