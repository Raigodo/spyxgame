import { describe, expect, it } from "vitest";
import { sanitizeLobbyConfig } from "./lobby-config";

describe("sanitizeLobbyConfig", () => {
  it("accepts free-for-all", () => {
    expect(sanitizeLobbyConfig({ mode: "free-for-all", junk: 1 })).toEqual({
      mode: "free-for-all",
    });
  });
  it("trims, dedupes and drops invalid team ids", () => {
    expect(
      sanitizeLobbyConfig({
        mode: "teams",
        teamIds: [" red ", "red", "blue", 5, "", "x".repeat(33)],
      })
    ).toEqual({ mode: "teams", teamIds: ["red", "blue"] });
  });
  it("needs 2 to 8 teams", () => {
    expect(sanitizeLobbyConfig({ mode: "teams", teamIds: ["a"] })).toBeUndefined();
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);
    expect(sanitizeLobbyConfig({ mode: "teams", teamIds: nine })).toBeUndefined();
  });
  it("rejects non-objects, arrays and unknown modes", () => {
    expect(sanitizeLobbyConfig("x")).toBeUndefined();
    expect(sanitizeLobbyConfig([])).toBeUndefined();
    expect(sanitizeLobbyConfig({ mode: "nope" })).toBeUndefined();
  });
});
