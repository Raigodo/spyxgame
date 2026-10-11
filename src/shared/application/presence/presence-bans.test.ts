import { describe, expect, it } from "vitest";
import { BAN_LIMIT, addBan, isBanned, parseBanPayload, parseBans } from "./presence-bans";

describe("presence-bans", () => {
  it("addBan appends a new id and ignores a duplicate", () => {
    const once = addBan([], "p1");
    expect(once).toEqual(["p1"]);
    expect(addBan(once, "p1")).toBe(once);
    expect(addBan(once, "p2")).toEqual(["p1", "p2"]);
  });

  it("addBan keeps only the newest BAN_LIMIT ids", () => {
    let state: readonly string[] = [];
    for (let i = 0; i < BAN_LIMIT + 10; i++) state = addBan(state, `p${i}`);
    expect(state).toHaveLength(BAN_LIMIT);
    expect(state[0]).toBe("p10");
    expect(state.at(-1)).toBe(`p${BAN_LIMIT + 9}`);
  });

  it("isBanned checks membership", () => {
    expect(isBanned(["a", "b"], "b")).toBe(true);
    expect(isBanned(["a", "b"], "c")).toBe(false);
  });

  it("parseBans keeps valid ids, drops invalid ones, and rejects non-arrays", () => {
    expect(parseBans("x")).toBeUndefined();
    expect(parseBans({})).toBeUndefined();
    expect(parseBans(["a", 1, "", "x".repeat(129), "b"])).toEqual(["a", "b"]);
  });

  it("parseBans trims to the newest BAN_LIMIT ids", () => {
    const many = Array.from({ length: BAN_LIMIT + 5 }, (_, i) => `p${i}`);
    const parsed = parseBans(many);
    expect(parsed).toHaveLength(BAN_LIMIT);
    expect(parsed?.[0]).toBe("p5");
  });

  it("parseBanPayload needs a valid string playerId", () => {
    expect(parseBanPayload({ playerId: "p1", extra: 1 })).toEqual({ playerId: "p1" });
    expect(parseBanPayload({ playerId: "" })).toBeUndefined();
    expect(parseBanPayload({ playerId: 5 })).toBeUndefined();
    expect(parseBanPayload({ playerId: "x".repeat(129) })).toBeUndefined();
    expect(parseBanPayload(null)).toBeUndefined();
    expect(parseBanPayload("p1")).toBeUndefined();
  });
});
