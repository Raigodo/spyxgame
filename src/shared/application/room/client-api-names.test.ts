import { describe, expect, it } from "vitest";
import { demoTap } from "@/demo-tap/demo-tap";
import { RoomHarness } from "@/shared/testing/room-harness";
import { MultiplayerClient } from "./multiplayer-client";

describe("MultiplayerClient naming", () => {
  it("has no hook-like methods and no 'session' event names", () => {
    const names = Object.getOwnPropertyNames(MultiplayerClient.prototype);
    expect(names.filter((n) => /^use[A-Z]/.test(n))).toEqual([]);
    expect(names).not.toContain("onSessionSuperseded");
    expect(names).toContain("getGame");
    expect(names).toContain("onSuperseded");
  });

  it("getGame returns the same handle every call and works before join", () => {
    const client = new RoomHarness().addClient("a", { games: [demoTap] }).client;
    expect(client.getGame(demoTap)).toBe(client.getGame(demoTap));
    expect(client.getGame(demoTap).getState()).toBeUndefined();
  });
});
