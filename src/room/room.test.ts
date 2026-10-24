import { describe, expect, it } from "vitest";
import { FakeRoomMembership } from "@/transport/fakes";
import { DEFAULT_ROOM_CONFIG } from "./config";
import * as api from "./index";
import { RoomHarness } from "./fakes";

const ROOM = "room1";
const rosterNames = (r: {
  roster: { state: { players: { get(): readonly { name: string }[] } } };
}) => r.roster.state.players.get().map((p) => p.name);

describe("public surface", () => {
  it("exports exactly the documented runtime values", () => {
    expect(Object.keys(api).sort()).toEqual(["DEFAULT_ROOM_CONFIG", "joinRoom"]);
  });
  it("the default config has one section per layer", () => {
    expect(Object.keys(DEFAULT_ROOM_CONFIG).sort()).toEqual(["bus", "link", "roster", "signaling"]);
  });
});

describe("joinRoom", () => {
  it("the first tab becomes host, gets a minted playerId and a ready bus", async () => {
    const h = new RoomHarness();
    const tab = h.addTab("a");
    const { room, generated } = await h.join(tab, ROOM, { nickname: "Ann" });
    await h.advance(500);
    expect(generated).toBe(true);
    expect(room.roomId).toBe(ROOM);
    expect(room.role.get()).toBe("host");
    expect(room.sync.get()).toBe("ready");
    expect(room.ended.get()).toBeUndefined();
    expect(room.roster.state.me.get()?.name).toBe("Ann");
  });

  it("a given playerId is kept and not reported as generated", async () => {
    const h = new RoomHarness();
    const { room, generated } = await h.join(h.addTab("a"), ROOM, { playerId: "player-fixed" });
    expect(generated).toBe(false);
    expect(room.playerId).toBe("player-fixed");
  });

  it("fails with `unavailable` when signaling cannot be reached, and leaves nothing behind", async () => {
    const h = new RoomHarness();
    class Broken extends FakeRoomMembership {
      override roomExists(): Promise<boolean> {
        return Promise.reject(new Error("offline"));
      }
    }
    const tab = h.addTab("a", { membership: new Broken(h.firestore) });
    const result = await h.tryJoin(tab, ROOM);
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(tab.room).toBeUndefined();
  });

  it("two tabs share one roster", async () => {
    const h = new RoomHarness();
    const a = h.addTab("a");
    const b = h.addTab("b");
    const ra = (await h.join(a, ROOM, { nickname: "Ann" })).room;
    const rb = (await h.join(b, ROOM, { nickname: "Bob" })).room;
    await h.advance(2_000);
    expect(rosterNames(ra)).toEqual(["Ann", "Bob"]);
    expect(rosterNames(rb)).toEqual(["Ann", "Bob"]);
    expect(rb.role.get()).toBe("guest");
    expect(rb.roster.state.host.get()?.name).toBe("Ann");
    expect(rb.sync.get()).toBe("ready");
  });
});

describe("room.leave", () => {
  it("is idempotent, and the others see the player expire", async () => {
    const h = new RoomHarness();
    const ra = (await h.join(h.addTab("a"), ROOM, { nickname: "Ann" })).room;
    const rb = (await h.join(h.addTab("b"), ROOM, { nickname: "Bob" })).room;
    await h.advance(2_000);
    await rb.leave();
    await rb.leave();
    await h.advance(1_000);
    expect(ra.roster.state.players.get().find((p) => p.name === "Bob")?.presence).toBe(
      "reconnecting"
    );
    await h.advance(6_000);
    expect(rosterNames(ra)).toEqual(["Ann"]);
    expect(rb.ended.get()).toBeUndefined();
  });
});

describe("room.ended", () => {
  async function trio() {
    const h = new RoomHarness();
    const ra = (await h.join(h.addTab("a"), ROOM, { nickname: "Ann" })).room;
    const rb = (await h.join(h.addTab("b"), ROOM, { nickname: "Bob" })).room;
    await h.advance(2_000);
    return { h, ra, rb };
  }

  it("a kicked guest ends with `kicked`, and the room forgets it after the grace period", async () => {
    const { h, ra, rb } = await trio();
    const kick = ra.roster.actions.kick(rb.playerId);
    await h.advance(2_000);
    expect((await kick).ok).toBe(true);
    expect(rb.ended.get()).toEqual({ reason: "kicked" });
    await h.advance(6_000);
    expect(rosterNames(ra)).toEqual(["Ann"]);
  });

  it("a second live tab of the same player ends with `superseded`; the first is untouched", async () => {
    const { h, ra, rb } = await trio();
    const tab = h.addTab("b2");
    const rb2 = (await h.join(tab, ROOM, { playerId: rb.playerId, nickname: "Bob2" })).room;
    await h.advance(8_000);
    expect(rb2.ended.get()).toEqual({ reason: "superseded" });
    expect(rb.ended.get()).toBeUndefined();
    expect(ra.roster.state.players.get().find((p) => p.id === rb.playerId)?.peerId).toBe(rb.self);
  });

  it("a banned player who comes back ends with `kicked`", async () => {
    const { h, ra, rb } = await trio();
    const ban = ra.roster.actions.ban(rb.playerId);
    await h.advance(2_000);
    expect((await ban).ok).toBe(true);
    const rb2 = (await h.join(h.addTab("b2"), ROOM, { playerId: rb.playerId })).room;
    await h.advance(8_000);
    expect(rb2.ended.get()).toEqual({ reason: "kicked" });
    expect(rosterNames(ra)).toEqual(["Ann"]);
  });
});

describe("room.debug", () => {
  it("returns a snapshot of the live room", async () => {
    const h = new RoomHarness();
    const { room } = await h.join(h.addTab("a"), ROOM, { nickname: "Ann" });
    await h.advance(500);
    const snap = room.debug();
    expect(snap).toMatchObject({ roomId: ROOM, role: "host", sync: "ready", ended: undefined });
    expect((snap.players as unknown[]).length).toBe(1);
  });
});
