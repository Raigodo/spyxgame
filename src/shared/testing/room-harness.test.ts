import { describe, expect, it } from "vitest";
import { RoomHarness } from "./room-harness";

describe("room harness smoke scenarios", () => {
  it("a second player joins, links up and both sides see each other", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, "room1");
    await h.join(b, "room1");

    expect(a.client.isHost()).toBe(true);
    expect(b.client.isHost()).toBe(false);
    expect(a.client.getStatus()).toBe("ready");
    expect(b.client.getStatus()).toBe("ready");
    expect(a.client.getPlayers()).toHaveLength(2);
    expect(b.client.getPlayers()).toHaveLength(2);
  });

  it("a chat message from the host reaches the guest", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, "room1");
    await h.join(b, "room1");

    expect(a.client.sendChat("hi")).toBe("sent");
    await h.settle();

    expect(a.client.getChat().map((l) => l.text)).toEqual(["hi"]);
    expect(b.client.getChat().map((l) => l.text)).toEqual(["hi"]);
  });

  it("a guest's ready state reaches the host", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, "room1");
    await h.join(b, "room1");

    b.client.setReady(true);
    await h.settle();

    expect(a.client.getPlayers().filter((p) => p.ready)).toHaveLength(1);
  });

  it("when the host dies, the guest becomes host and the room is usable again", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, "room1");
    await h.join(b, "room1");

    a.kill(1_000);
    await h.advance(20_000);

    expect(b.client.isHost()).toBe(true);
    expect(b.client.getStatus()).toBe("ready");
    expect(b.client.getPlayers()).toHaveLength(1);
  });
});
