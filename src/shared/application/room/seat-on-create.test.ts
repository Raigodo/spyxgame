import { expect, it } from "vitest";
import { RoomHarness } from "@/shared/testing/room-harness";

it("the room creator's host seat is remembered even though its host event fires during join", async () => {
  const h = new RoomHarness();
  const a = h.addClient("a");
  await h.join(a, "room1");

  const raw = a.tabStore.get("host-claim:room1");
  expect(raw).toBeDefined();
  expect(JSON.parse(raw ?? "{}")).toMatchObject({ peerId: a.client.getLocalPeerId() });
});

it("a guest that is promoted later remembers the seat through the wired handler", async () => {
  const h = new RoomHarness();
  const a = h.addClient("a");
  const b = h.addClient("b");
  await h.join(a, "room1");
  await h.join(b, "room1");
  expect(b.tabStore.get("host-claim:room1")).toBeUndefined();

  a.kill(1_000);
  await h.advance(10_000);

  expect(b.client.isHost()).toBe(true);
  expect(JSON.parse(b.tabStore.get("host-claim:room1") ?? "{}")).toMatchObject({
    peerId: b.client.getLocalPeerId(),
  });
});
