import { describe, expect, it } from "vitest";
import { as, type PeerId, type PlayerId } from "@/kernel";
import type { Entry, RosterState } from "./model";
import {
  EMPTY_ROSTER,
  applyBan,
  applyJoin,
  applyRemove,
  applyRename,
  applySync,
  applyUnban,
  entriesToPlayers,
  nextGhostExpiry,
  type Actor,
} from "./rules";

const player = as<PlayerId>;
const peer = as<PeerId>;
const actor = (p: string, from: string, now = 100): Actor => ({
  from: peer(from),
  playerId: player(p),
  now,
});
const entry = (o: Partial<Entry> = {}): Entry => ({
  name: "n",
  joinedAt: 1,
  peerId: peer("x"),
  link: "active",
  ...o,
});
const ghost = (goneAt?: number): Entry => ({
  name: "g",
  joinedAt: 1,
  link: "reconnecting",
  ...(goneAt !== undefined && { goneAt }),
});
const state = (entries: Record<string, Entry>, bans: string[] = []): RosterState => ({
  entries,
  bans: bans.map(player),
});

describe("applyJoin", () => {
  const limits = { maxPlayers: 2 };

  it("creates a connecting row for a new player", () => {
    const r = applyJoin(EMPTY_ROSTER, "Ann", actor("p1", "x", 50), limits);
    expect(r).toEqual({
      ok: true,
      value: {
        entries: { p1: { name: "Ann", joinedAt: 50, peerId: "x", link: "connecting" } },
        bans: [],
      },
    });
  });

  it("a banned player is refused", () => {
    expect(applyJoin(state({}, ["p1"]), "Ann", actor("p1", "x"), limits)).toEqual({
      ok: false,
      reason: "banned",
    });
  });

  it("a new player in a full room is refused, a returning one is not", () => {
    const full = state({ p1: entry({ peerId: peer("a"), link: "connecting" }), p2: entry() });
    expect(applyJoin(full, "Cat", actor("p3", "z"), limits)).toEqual({ ok: false, reason: "full" });
    expect(applyJoin(full, "Ann", actor("p1", "new"), limits).ok).toBe(true);
  });

  it("a repeated join from the holding peer changes nothing", () => {
    const s = state({ p1: entry({ peerId: peer("x") }) });
    const r = applyJoin(s, "Ann", actor("p1", "x"), limits);
    expect(r.ok && r.value).toBe(s);
  });

  it("another peer with an active link is `taken`", () => {
    const s = state({ p1: entry({ peerId: peer("old"), link: "active" }) });
    expect(applyJoin(s, "Ann", actor("p1", "new"), limits)).toEqual({ ok: false, reason: "taken" });
  });

  it("takeover keeps the stored name and joinedAt", () => {
    const s = state({
      p1: entry({ name: "Old", joinedAt: 5, peerId: peer("old"), link: "connecting" }),
    });
    const r = applyJoin(s, "Ignored", actor("p1", "new"), limits);
    expect(r.ok && r.value.entries.p1).toEqual({
      name: "Old",
      joinedAt: 5,
      peerId: "new",
      link: "connecting",
    });
  });

  it("a ghost is taken over and loses its goneAt", () => {
    const r = applyJoin(state({ p1: ghost(3) }), "x", actor("p1", "new"), limits);
    expect(r.ok && r.value.entries.p1).toEqual({
      name: "g",
      joinedAt: 1,
      peerId: "new",
      link: "connecting",
    });
  });
});

describe("applyRename", () => {
  it("unknown player, same name (no-op) and a real rename", () => {
    expect(applyRename(EMPTY_ROSTER, "A", actor("p1", "x"))).toEqual({
      ok: false,
      reason: "unknown-player",
    });
    const s = state({ p1: entry({ name: "A" }) });
    const same = applyRename(s, "A", actor("p1", "x"));
    expect(same.ok && same.value).toBe(s);
    const changed = applyRename(s, "B", actor("p1", "x"));
    expect(changed.ok && changed.value.entries.p1?.name).toBe("B");
  });
});

describe("applySync", () => {
  const host = { from: peer("host"), now: 1_000 };
  const grace = 4_000;

  it("sets link states; the host's own row is always active", () => {
    const s = state({
      h: entry({ peerId: peer("host"), link: "connecting" }),
      g: entry({ peerId: peer("g1"), link: "connecting" }),
    });
    const next = applySync(s, { g1: "active" }, host, grace);
    expect(next.entries.h?.link).toBe("active");
    expect(next.entries.g?.link).toBe("active");
  });

  it("a peer that left membership becomes a ghost stamped with host time", () => {
    const s = state({ g: entry({ name: "G", joinedAt: 7, peerId: peer("gone") }) });
    const next = applySync(s, {}, host, grace);
    expect(next.entries.g).toEqual({ name: "G", joinedAt: 7, link: "reconnecting", goneAt: 1_000 });
  });

  it("a ghost stays until its grace ran out, then is removed", () => {
    const s = state({ g: ghost(1_000) });
    expect(applySync(s, {}, { ...host, now: 4_999 }, grace)).toBe(s);
    expect(applySync(s, {}, { ...host, now: 5_000 }, grace).entries).toEqual({});
  });

  it("a ghost without goneAt gets one", () => {
    const next = applySync(state({ g: ghost() }), {}, host, grace);
    expect(next.entries.g?.goneAt).toBe(1_000);
  });

  it("returns the same state when nothing changed", () => {
    const s = state({ g: entry({ peerId: peer("g1"), link: "active" }) });
    expect(applySync(s, { g1: "active" }, host, grace)).toBe(s);
  });

  it("a returning peer clears goneAt", () => {
    const s = state({ g: { ...entry({ peerId: peer("g1"), link: "reconnecting" }), goneAt: 5 } });
    const next = applySync(s, { g1: "active" }, host, grace);
    expect(next.entries.g).toEqual({ name: "n", joinedAt: 1, peerId: "g1", link: "active" });
  });
});

describe("applyRemove / applyBan / applyUnban", () => {
  const host = actor("host", "h");

  it("remove: not self, must exist, deletes the row", () => {
    const s = state({ host: entry(), p1: entry() });
    expect(applyRemove(s, player("host"), host)).toEqual({
      ok: false,
      reason: "cannot-target-self",
    });
    expect(applyRemove(s, player("zz"), host)).toEqual({ ok: false, reason: "unknown-player" });
    const r = applyRemove(s, player("p1"), host);
    expect(r.ok && Object.keys(r.value.entries)).toEqual(["host"]);
  });

  it("ban: removes the row and records the ban, also for an absent player", () => {
    const s = state({ host: entry(), p1: entry() });
    const r = applyBan(s, player("p1"), host, { banLimit: 5 });
    expect(r.ok && r.value.bans).toEqual(["p1"]);
    expect(r.ok && "p1" in r.value.entries).toBe(false);
    const absent = applyBan(EMPTY_ROSTER, player("ghost"), host, { banLimit: 5 });
    expect(absent.ok && absent.value.bans).toEqual(["ghost"]);
  });

  it("ban: self refused, already banned is a no-op, the newest bans win at the limit", () => {
    expect(applyBan(EMPTY_ROSTER, player("host"), host, { banLimit: 5 })).toEqual({
      ok: false,
      reason: "cannot-target-self",
    });
    const banned = state({}, ["p1"]);
    const again = applyBan(banned, player("p1"), host, { banLimit: 5 });
    expect(again.ok && again.value).toBe(banned);
    const full = applyBan(state({}, ["a", "b"]), player("c"), host, { banLimit: 2 });
    expect(full.ok && full.value.bans).toEqual(["b", "c"]);
  });

  it("unban removes the ban; an unknown ban is refused", () => {
    expect(applyUnban(EMPTY_ROSTER, player("p1"))).toEqual({ ok: false, reason: "unknown-player" });
    const r = applyUnban(state({}, ["p1", "p2"]), player("p1"));
    expect(r.ok && r.value.bans).toEqual(["p2"]);
  });
});

describe("entriesToPlayers", () => {
  const s = state({
    p1: entry({ joinedAt: 1, peerId: peer("me"), link: "connecting" }),
    p2: entry({ joinedAt: 5, peerId: peer("y"), link: "active" }),
    p3: { name: "g", joinedAt: 5, link: "reconnecting", goneAt: 1 },
    p4: entry({ joinedAt: 9, peerId: peer("z"), link: "connecting" }),
    p5: entry({ joinedAt: 9, peerId: peer("w"), link: "reconnecting" }),
  });
  const players = entriesToPlayers(s, { selfPeerId: peer("me"), hostPeerId: peer("y") });

  it("orders by joinedAt then id, ghosts included", () => {
    expect(players.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });
  it("presence: self overlay, online for active, the link state otherwise, ghost reconnecting", () => {
    expect(players.map((p) => p.presence)).toEqual([
      "self",
      "online",
      "reconnecting",
      "connecting",
      "reconnecting",
    ]);
  });
  it("marks the host row and gives a ghost no peerId", () => {
    expect(players.filter((p) => p.isHost).map((p) => p.id)).toEqual(["p2"]);
    expect("peerId" in (players[2] as object)).toBe(false);
  });
  it("without a host nobody is host", () => {
    const none = entriesToPlayers(s, { selfPeerId: peer("me"), hostPeerId: undefined });
    expect(none.some((p) => p.isHost)).toBe(false);
  });
});

describe("nextGhostExpiry", () => {
  it("undefined without ghosts, ignores a ghost without goneAt, picks the earliest", () => {
    expect(nextGhostExpiry(state({ a: entry() }), 4_000)).toBeUndefined();
    expect(nextGhostExpiry(state({ g: ghost() }), 4_000)).toBeUndefined();
    expect(nextGhostExpiry(state({ a: ghost(500), b: ghost(100) }), 4_000)).toBe(4_100);
  });
});
