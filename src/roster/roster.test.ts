import { describe, expect, it } from "vitest";
import { RosterHarness, names } from "@/roster/fakes";
import * as api from "./index";
import { PROFILE_KEY_PREFIX } from "./names";

async function pair() {
  const h = new RosterHarness();
  const a = h.addPeer("a");
  const b = h.addPeer("b");
  await h.settle();
  return { h, a, b };
}
const rows = (p: {
  roster: { state: { players: { get(): readonly { name: string; presence: string }[] } } };
}) => p.roster.state.players.get().map((x) => [x.name, x.presence]);

describe("public surface", () => {
  it("exports exactly the documented runtime values", () => {
    expect(Object.keys(api).sort()).toEqual([
      "DEFAULT_ROSTER_CONFIG",
      "createRoster",
      "rosterConfig",
    ]);
  });
});

describe("roster: joining", () => {
  it("two peers see each other with the right presence and host", async () => {
    const { a, b } = await pair();
    expect(rows(a)).toEqual([
      ["a", "self"],
      ["b", "online"],
    ]);
    expect(rows(b)).toEqual([
      ["a", "online"],
      ["b", "self"],
    ]);
    expect(a.roster.state.host.get()?.name).toBe("a");
    expect(b.roster.state.host.get()?.name).toBe("a");
    expect(b.roster.state.me.get()?.id).toBe(b.playerId);
  });

  it("a newcomer has no `me` until admitted", async () => {
    const { h } = await pair();
    const c = h.addPeer("c");
    expect(c.roster.state.me.get()).toBeUndefined();
    await h.settle();
    expect(c.roster.state.me.get()?.name).toBe("c");
  });

  it("announces joined to the others, but nothing for the initial load", async () => {
    const h = new RosterHarness();
    const a = h.addPeer("a");
    await h.settle();
    const joined: string[] = [];
    a.roster.events.joined.on((p) => joined.push(p.name));
    const b = h.addPeer("b");
    const bJoined: string[] = [];
    b.roster.events.joined.on((p) => bJoined.push(p.name));
    await h.settle();
    expect(joined).toEqual(["b"]);
    expect(bJoined).toEqual(["b"]); // own admission; the initial load (a) is not announced
  });
});

describe("roster: rename", () => {
  it("renames for everyone and remembers the nickname", async () => {
    const { h, a, b } = await pair();
    const p = b.roster.actions.rename("bee");
    await h.settle();
    expect((await p).ok).toBe(true);
    expect(names(a.roster.state.players.get())).toEqual(["a", "bee"]);
    expect(b.profileStore.get(`${PROFILE_KEY_PREFIX}name`)).toBe("bee");
  });

  it("rejects an empty or too long name without touching the roster", async () => {
    const { b } = await pair();
    expect(await b.roster.actions.rename("   ")).toEqual({ ok: false, reason: "invalid" });
    expect(await b.roster.actions.rename("x".repeat(33))).toEqual({ ok: false, reason: "invalid" });
    expect(b.roster.state.me.get()?.name).toBe("b");
  });
});

describe("roster: refresh and ghosts", () => {
  it("a guest refresh is one row going reconnecting then online, same name", async () => {
    const { h, a, b } = await pair();
    const rejoined: string[] = [];
    const left: string[] = [];
    a.roster.events.rejoined.on((p) => rejoined.push(p.name));
    a.roster.events.left.on((e) => left.push(e.player.name));
    const b2 = await h.refresh(b);
    await h.advance(1_000);
    expect(names(a.roster.state.players.get())).toEqual(["a", "b"]);
    expect(a.roster.state.players.get()[1]?.peerId).toBe(b2.peerId);
    expect(b2.roster.state.me.get()?.name).toBe("b");
    expect(rejoined).toEqual(["b"]);
    expect(left).toEqual([]);
  });

  it("refreshing twice in a row never makes a double row", async () => {
    const { h, a, b } = await pair();
    const b2 = await h.refresh(b);
    const b3 = await h.refresh(b2);
    await h.advance(1_000);
    expect(names(a.roster.state.players.get())).toEqual(["a", "b"]);
    expect(b3.roster.state.me.get()?.id).toBe(b.playerId);
  });

  it("a dead peer stays as a ghost for the grace period, then expires", async () => {
    const { h, a, b } = await pair();
    const left: string[] = [];
    a.roster.events.left.on((e) => left.push(`${e.player.name}:${e.reason}`));
    h.kill(b);
    await h.settle();
    expect(rows(a)).toEqual([
      ["a", "self"],
      ["b", "reconnecting"],
    ]);
    expect(a.roster.state.players.get()[1]?.peerId).toBeUndefined();
    await h.advance(3_000);
    expect(names(a.roster.state.players.get())).toEqual(["a", "b"]);
    await h.advance(2_000);
    expect(names(a.roster.state.players.get())).toEqual(["a"]);
    expect(left).toEqual(["b:expired"]);
  });
});

describe("roster: host failover", () => {
  it("the new host takes over the roster and expires the dead host's ghost", async () => {
    const { h, a, b } = await pair();
    h.kill(a);
    h.setHost("b");
    await h.advance(1_000);
    expect(b.roster.state.host.get()?.name).toBe("b");
    expect(rows(b)).toEqual([
      ["a", "reconnecting"],
      ["b", "self"],
    ]);
    await h.advance(6_000);
    expect(names(b.roster.state.players.get())).toEqual(["b"]);
  });

  it("handOff moves the host role and the isHost flag", async () => {
    const { h, a, b } = await pair();
    const r = await a.roster.actions.handOff(b.playerId);
    expect(r.ok).toBe(true);
    await h.advance(5_000);
    expect(a.roster.state.host.get()?.name).toBe("b");
    expect(b.roster.state.host.get()?.name).toBe("b");
    expect(names(a.roster.state.players.get())).toEqual(["a", "b"]);
  });

  it("handOff rejections: guest, self, unknown", async () => {
    const { a, b } = await pair();
    expect(await b.roster.actions.handOff(a.playerId)).toEqual({ ok: false, reason: "not-host" });
    expect(await a.roster.actions.handOff(a.playerId)).toEqual({
      ok: false,
      reason: "cannot-target-self",
    });
    expect(await a.roster.actions.handOff("nobody" as typeof a.playerId)).toEqual({
      ok: false,
      reason: "unknown-player",
    });
  });
});

describe("roster: duplicate tabs", () => {
  it("a second live tab of a guest is dropped, the first keeps its row", async () => {
    const { h, a, b } = await pair();
    const b2 = h.addPeer("b2", { playerId: b.playerId });
    await h.advance(5_000);
    expect(a.transport.members.get().has(b2.peerId)).toBe(false);
    expect(a.roster.state.players.get().find((p) => p.id === b.playerId)?.peerId).toBe(b.peerId);
    expect(names(a.roster.state.players.get())).toEqual(["a", "b"]);
  });

  it("a second tab of the host's own player is dropped", async () => {
    const { h, a } = await pair();
    const a2 = h.addPeer("a2", { playerId: a.playerId });
    await h.advance(5_000);
    expect(a.transport.members.get().has(a2.peerId)).toBe(false);
    expect(a.roster.state.me.get()?.peerId).toBe(a.peerId);
  });

  it("when the first tab died silently, the new tab takes the row and the dead one is dropped", async () => {
    const { h, a, b } = await pair();
    h.kill(b, { removeMember: false });
    const b2 = h.addPeer("b2", { playerId: b.playerId });
    await h.advance(5_000);
    expect(a.roster.state.players.get().find((p) => p.id === b.playerId)?.peerId).toBe(b2.peerId);
    expect(a.transport.members.get().has(b.peerId)).toBe(false);
    expect(names(a.roster.state.players.get())).toEqual(["a", "b"]);
  });
});

describe("roster: moderation", () => {
  it("kick removes the row at once and reports `removed`", async () => {
    const { h, a, b } = await pair();
    const left: string[] = [];
    a.roster.events.left.on((e) => left.push(`${e.player.name}:${e.reason}`));
    const r = await a.roster.actions.kick(b.playerId);
    expect(r.ok).toBe(true);
    await h.settle();
    expect(names(a.roster.state.players.get())).toEqual(["a"]);
    expect(left).toEqual(["b:removed"]);
    expect(a.transport.members.get().has(b.peerId)).toBe(false);
  });

  it("kick rejections: guest, self, unknown", async () => {
    const { a, b } = await pair();
    expect(await b.roster.actions.kick(a.playerId)).toEqual({ ok: false, reason: "not-host" });
    expect(await a.roster.actions.kick(a.playerId)).toEqual({
      ok: false,
      reason: "cannot-target-self",
    });
    expect(await a.roster.actions.kick("nobody" as typeof a.playerId)).toEqual({
      ok: false,
      reason: "unknown-player",
    });
  });

  it("a kicked player may join again through a new tab", async () => {
    const { h, a, b } = await pair();
    await a.roster.actions.kick(b.playerId);
    await h.settle();
    h.addPeer("b2", { playerId: b.playerId });
    await h.advance(2_000);
    expect(names(a.roster.state.players.get())).toEqual(["a", "b2"]);
  });

  it("ban records the ban, removes the row, and a banned player cannot come back", async () => {
    const { h, a, b } = await pair();
    expect((await a.roster.actions.ban(b.playerId)).ok).toBe(true);
    await h.settle();
    expect([...a.roster.state.bans.get()]).toEqual([b.playerId]);
    expect(names(a.roster.state.players.get())).toEqual(["a"]);

    const b2 = h.addPeer("b2", { playerId: b.playerId });
    await h.advance(2_000);
    expect(a.transport.members.get().has(b2.peerId)).toBe(false);
    expect(names(a.roster.state.players.get())).toEqual(["a"]);
  });

  it("unban lets the player in again; an unknown ban is refused", async () => {
    const { h, a, b } = await pair();
    await a.roster.actions.ban(b.playerId);
    await h.settle();
    expect((await a.roster.actions.unban(b.playerId)).ok).toBe(true);
    expect(a.roster.state.bans.get().size).toBe(0);
    expect(await a.roster.actions.unban(b.playerId)).toEqual({
      ok: false,
      reason: "unknown-player",
    });
    h.addPeer("b3", { playerId: b.playerId });
    await h.advance(2_000);
    expect(names(a.roster.state.players.get())).toEqual(["a", "b3"]);
  });
});
