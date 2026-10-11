import { describe, expect, it } from "vitest";
import { RoomHarness } from "./room-harness";

const ROOM = "room1";

// Pins the presence coordinator's behavior before it is split. Hand-traced against the code:
// if one fails, first check whether the scenario or the code is wrong, then tell me.

describe("duplicate tab, old tab alive", () => {
  it("the newcomer is rejected and the live old tab is never removed", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    const c = h.addClient("c");
    await h.join(a, ROOM);
    const { playerId } = await h.join(b, ROOM);

    await h.join(c, ROOM, playerId); // same playerId as b, while b is alive
    await h.advance(6_000);

    expect(c.client.getStatus()).toBe("superseded");
    expect(b.client.getStatus()).toBe("ready");
    expect(a.client.getPlayers()).toHaveLength(2);
    expect(a.client.getPlayers().some((p) => p.peerId === b.client.getLocalPeerId())).toBe(true);
  });
});

describe("duplicate tab, old tab dead", () => {
  it("the silent old tab is removed as a ghost and the newcomer takes its place", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    const { playerId } = await h.join(b, ROOM);
    const oldPeerId = b.client.getLocalPeerId();

    b.kill(1_000); // no leave, no pagehide
    const c = h.addClient("c");
    await h.join(c, ROOM, playerId);
    await h.advance(8_000);

    const peers = a.client.getPlayers().map((p) => p.peerId);
    expect(c.client.getStatus()).toBe("ready");
    expect(peers).toContain(c.client.getLocalPeerId());
    expect(peers).not.toContain(oldPeerId);
    expect(peers).toHaveLength(2);
  });
});

describe("kick", () => {
  it("the kicked player is told, and the others keep no ghost row for them", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    await h.join(b, ROOM);
    const bPeerId = b.client.getLocalPeerId() ?? "";

    await expect(a.client.kickPlayer(bPeerId)).resolves.toEqual({ ok: true });
    await h.advance(1_000);

    expect(b.client.getStatus()).toBe("kicked");
    expect(a.client.getPlayers()).toHaveLength(1);
  });
});

describe("refresh restores state", () => {
  it("a guest's ready flag survives a refresh and the new row is flagged as returning", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    await h.join(b, ROOM);
    b.client.setReady(true);
    await h.settle();

    const b2 = await h.refresh(b, ROOM);
    await h.advance(8_000);

    const row = a.client.getPlayers().find((p) => p.peerId === b2.client.getLocalPeerId());
    expect(a.client.getPlayers()).toHaveLength(2);
    expect(row?.ready).toBe(true);
    expect(row?.returning).toBe(true);
  });
});

describe("history survives host changes", () => {
  it("a refreshed host gets its own ready flag back", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    await h.join(b, ROOM);
    a.client.setReady(true);
    await h.settle();

    const a2 = await h.refresh(a, ROOM);
    await h.advance(15_000);

    expect(a2.client.isHost()).toBe(true);
    expect(a2.client.getLocalPlayer()?.ready).toBe(true);
  });

  it("a player who left before the host died is still restored by the new host", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    const c = h.addClient("c");
    await h.join(a, ROOM);
    await h.join(b, ROOM);
    const { playerId } = await h.join(c, ROOM);
    c.client.setReady(true);
    await h.settle();

    await c.client.leave();
    await h.advance(1_000);
    a.kill(1_000);
    await h.advance(12_000);
    expect(b.client.isHost()).toBe(true);

    const c2 = h.addClient("c2", { profileStore: c.profileStore });
    await h.join(c2, ROOM, playerId);
    await h.advance(3_000);

    const row = b.client.getPlayers().find((p) => p.peerId === c2.client.getLocalPeerId());
    expect(row?.ready).toBe(true);
    expect(row?.returning).toBe(true);
  });
});
