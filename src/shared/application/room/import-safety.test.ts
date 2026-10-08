import { expect, it } from "vitest";

it("importing the client factory needs no Firebase env and no network", async () => {
  const mod = await import("./create-multiplayer-client");
  expect(typeof mod.createMultiplayerClient).toBe("function");
});
