import { describe, expect, it } from "vitest";
import { dig, recordMilestones } from "./milestones";
import { RoomHarness } from "./room-harness";

const ROOM = "room1";

// These tests print a timeline (fake milliseconds since the kill) so you can see where time goes
// before tuning any timer. Assertions are deliberately loose: they catch a broken failover, not a
// slow one. Tighten them when the timers are tightened.

describe("failover timeline: host dies", () => {
  it("guest takes over and the room becomes usable again", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    await h.join(b, ROOM);

    const deadId = a.client.getLocalPeerId() ?? "";
    const guestId = b.client.getLocalPeerId() ?? "";
    expect(deadId).not.toBe("");

    const state = () => b.client.getDebugState();
    a.kill(1_000);

    const t = await recordMilestones(
      h,
      {
        linkLost: () => {
          const status = dig(state(), "session", "rtc", "links", deadId, "status");
          return status === undefined || status === "reconnecting";
        },
        suspected: () =>
          dig(state(), "session", "rtc", "signaling", "election", "suspectedDeadHostId") === deadId,
        hostWritten: () => h.firestore.room(ROOM).host?.signalingPeerId === guestId,
        becameHost: () => b.client.isHost(),
        recovered: () => b.client.isHost() && dig(state(), "bus", "recovery") === null,
        ready: () => b.client.isHost() && b.client.getStatus() === "ready",
        deadRowGone: () => b.client.getPlayers().length === 1,
      },
      40_000
    );

    console.info("[timeline] host dies", t);

    expect(t.ready).toBeDefined();
    expect(t.ready ?? Infinity).toBeLessThan(12_000);
    expect(t.hostWritten).toBeDefined();
    expect(t.hostWritten ?? Infinity).toBeLessThan(8_000);
    expect(t.deadRowGone).toBeDefined();
    // Order: detection comes before the election result, which comes before readiness.
    expect(t.linkLost ?? Infinity).toBeLessThanOrEqual(t.hostWritten ?? -1);
    expect(t.hostWritten ?? Infinity).toBeLessThanOrEqual(t.ready ?? -1);
  }, 45_000);
});

describe("failover timeline: guest dies", () => {
  it("host notices, removes the guest from membership, and the row disappears", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, ROOM);
    await h.join(b, ROOM);

    const deadId = b.client.getLocalPeerId() ?? "";
    expect(deadId).not.toBe("");

    const state = () => a.client.getDebugState();
    b.kill(1_000);

    const t = await recordMilestones(
      h,
      {
        linkLost: () => {
          const status = dig(state(), "session", "rtc", "links", deadId, "status");
          return status === undefined || status === "reconnecting";
        },
        memberRemoved: () => !h.firestore.room(ROOM).peers.has(deadId),
        rowGone: () => a.client.getPlayers().length === 1,
      },
      60_000
    );

    console.info("[timeline] guest dies", t);

    expect(a.client.isHost()).toBe(true);
    expect(t.memberRemoved).toBeDefined();
    expect(t.memberRemoved ?? Infinity).toBeLessThan(30_000);
    expect(t.rowGone).toBeDefined();
    expect(t.memberRemoved ?? Infinity).toBeLessThanOrEqual(t.rowGone ?? -1);
  }, 65_000);
});
