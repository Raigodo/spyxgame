import { describe, expect, it } from "vitest";
import { sanitizeGameContext } from "./game-context";

const base = { lobby: { mode: "free-for-all" }, teams: {}, participants: ["p1"] };

describe("sanitizeGameContext", () => {
  it("accepts a valid context", () => {
    expect(sanitizeGameContext(base)).toEqual(base);
  });
  it("drops non-string participants and non-string team ids", () => {
    const out = sanitizeGameContext({
      ...base,
      participants: ["p1", 2],
      teams: { p1: "red", p2: 3 },
    });
    expect(out).toMatchObject({ participants: ["p1"], teams: { p1: "red" } });
  });
  it("rejects an invalid lobby, array teams, or missing participants", () => {
    expect(sanitizeGameContext({ ...base, lobby: { mode: "x" } })).toBeUndefined();
    expect(sanitizeGameContext({ ...base, teams: [] })).toBeUndefined();
    expect(sanitizeGameContext({ ...base, participants: "p1" })).toBeUndefined();
  });
});
