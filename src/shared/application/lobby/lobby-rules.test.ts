import { describe, expect, it } from "vitest";
import { allReady, normalizeTeam, teamChoiceError } from "./lobby-rules";
import type { LobbyConfig, LobbyPlayer } from "./types";

const teams: LobbyConfig = { mode: "teams", teamIds: ["red", "blue"] };
const ffa: LobbyConfig = { mode: "free-for-all" };
const player = (teamId?: string): LobbyPlayer => ({
  peerId: "p",
  playerId: "pid",
  nickname: "n",
  metadata: {},
  connectionStatus: "active",
  returning: false,
  ready: false,
  teamId,
});

describe("lobby-rules", () => {
  it("keeps a valid team and clears an unknown one", () => {
    expect(normalizeTeam(player("red"), teams).teamId).toBe("red");
    expect(normalizeTeam(player("green"), teams).teamId).toBeUndefined();
  });
  it("clears every team in free-for-all", () => {
    expect(normalizeTeam(player("red"), ffa).teamId).toBeUndefined();
  });
  it("all ready needs at least one player and everyone ready", () => {
    expect(allReady([])).toBe(false);
    expect(allReady([{ ready: true }, { ready: false }])).toBe(false);
    expect(allReady([{ ready: true }, { ready: true }])).toBe(true);
  });
  it("explains why a team cannot be chosen", () => {
    expect(teamChoiceError(ffa, "red")).toMatch(/not in teams mode/);
    expect(teamChoiceError(teams, "green")).toMatch(/Unknown team/);
    expect(teamChoiceError(teams, "red")).toBeUndefined();
  });
});
