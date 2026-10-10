import { describe, expect, it } from "vitest";
import { RoomHarness } from "./room-harness";

const ROOM = "room1";

describe("host refresh reclaims the seat", () => {
  it("with a pagehide stamp, the reloaded host is host again and the guest is not", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    await h.join(b, ROOM);

    const a2 = await h.refresh(a, ROOM);
    await h.advance(15_000);

    expect(a2.client.isHost()).toBe(true);
    expect(b.client.isHost()).toBe(false);
    expect(a2.client.getStatus()).toBe("ready");
  });

  it("without a stamp, a reload within the candidate window still reclaims", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    await h.join(b, ROOM);
    const playerId = a.client.getPlayerId();

    a.kill(1_000); // crash-like: no pagehide, guests notice after 1s
    await h.advance(1_500); // guests have suspected the host; the election window is still open
    const a2 = h.addClient("a2", { tabStore: a.tabStore, profileStore: a.profileStore });
    await h.join(a2, ROOM, playerId);
    await h.advance(15_000);

    expect(a2.client.isHost()).toBe(true);
    expect(b.client.isHost()).toBe(false);
  });
});
