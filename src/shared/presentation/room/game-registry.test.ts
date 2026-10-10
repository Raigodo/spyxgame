import { describe, expect, it } from "vitest";
import { demoTap } from "@/demo-tap/demo-tap";
import type { RegisteredGame } from "@/shared/application/game";
import { createGameRegistry } from "./game-registry";
import { GAMES, gameRoute } from "./games";

const other = { id: "other", runtime: demoTap.runtime } as RegisteredGame;

describe("createGameRegistry", () => {
  it("returns the games and looks routes up by id", () => {
    const registry = createGameRegistry([
      { definition: demoTap, route: "/demo-game" },
      { definition: other, route: "/other/play" },
    ]);
    expect(registry.games).toEqual([demoTap, other]);
    expect(registry.gameRoute("other")).toBe("/other/play");
    expect(registry.gameRoute("nope")).toBeUndefined();
  });
  it("rejects a duplicate id", () => {
    expect(() =>
      createGameRegistry([
        { definition: demoTap, route: "/a" },
        { definition: demoTap, route: "/b" },
      ])
    ).toThrow(/Duplicate/);
  });
  it("rejects malformed routes", () => {
    for (const route of ["", "demo", "/demo/", "//x", "/a b", "/"]) {
      expect(() => createGameRegistry([{ definition: demoTap, route }])).toThrow(/Bad route/);
    }
  });
});

describe("the app's game list", () => {
  it("registers demo-tap with a route", () => {
    expect(GAMES.map((g) => g.id)).toContain("demo-tap");
    expect(gameRoute("demo-tap")).toBe("/demo-game");
  });
});
