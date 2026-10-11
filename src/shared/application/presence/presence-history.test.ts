import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  findEntry,
  missingKeys,
  parseEntry,
  parseHistory,
  rememberEntry,
} from "./presence-history";

const entry = (playerId: string, metadata: Record<string, unknown> = {}) => ({
  playerId,
  metadata,
});

describe("presence-history", () => {
  it("rejects malformed entries", () => {
    expect(parseEntry(null)).toBeUndefined();
    expect(parseEntry({ playerId: "", metadata: {} })).toBeUndefined();
    expect(parseEntry({ playerId: "p", metadata: [] })).toBeUndefined();
    expect(parseEntry({ playerId: "p", metadata: { x: "y".repeat(5_000) } })).toBeUndefined();
    expect(parseEntry({ playerId: "p", metadata: { a: 1 } })).toEqual(entry("p", { a: 1 }));
  });
  it("parseHistory keeps valid entries and trims to the newest ones", () => {
    expect(parseHistory("x")).toBeUndefined();
    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => entry(`p${i}`));
    const parsed = parseHistory([...many, { bad: true }]);
    expect(parsed).toHaveLength(HISTORY_LIMIT);
    expect(parsed?.at(-1)?.playerId).toBe(`p${HISTORY_LIMIT + 4}`);
    expect(parsed?.[0]?.playerId).toBe("p5");
  });
  it("rememberEntry replaces the same player, moves it last, and caps the size", () => {
    let state = rememberEntry([], entry("a", { v: 1 }));
    state = rememberEntry(state, entry("b"));
    state = rememberEntry(state, entry("a", { v: 2 }));
    expect(state.map((e) => e.playerId)).toEqual(["b", "a"]);
    expect(findEntry(state, "a")?.metadata).toEqual({ v: 2 });
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) state = rememberEntry(state, entry(`x${i}`));
    expect(state).toHaveLength(HISTORY_LIMIT);
  });
  it("missingKeys returns only keys the local profile lacks", () => {
    expect(
      missingKeys({ readyRound: 1, teamId: "red" }, { playerId: "p", teamId: "blue" })
    ).toEqual({
      readyRound: 1,
    });
    expect(missingKeys({ teamId: "red" }, { teamId: null })).toBeUndefined();
  });
});
