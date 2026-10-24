import { describe, expect, it } from "vitest";
import { GAME_DEFS } from "./definitions";

describe("GAME_DEFS", () => {
  it("lists demo-tap and spy, with unique ids", () => {
    const ids = GAME_DEFS.map((g) => g.id);
    expect(ids).toEqual(["demo-tap", "spy"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every definition carries a runtime with its own id and at least one mode", () => {
    for (const def of GAME_DEFS) {
      expect(def.runtime.id).toBe(def.id);
      expect(def.modes.length).toBeGreaterThan(0);
    }
  });
});
