import { describe, expect, it } from "vitest";
import { createRosterSchemas } from "./model";

const schemas = createRosterSchemas({ maxPlayers: 2, maxNameLength: 5, banLimit: 2 });
const row = (o: Record<string, unknown> = {}) => ({
  name: "Ann",
  joinedAt: 1,
  peerId: "x",
  link: "active",
  ...o,
});

describe("roster state schema", () => {
  it("accepts a valid state and strips unknown keys", () => {
    const out = schemas.state.parse({ entries: { p1: { ...row(), extra: 1 } }, bans: ["p9"] });
    expect(out).toEqual({ entries: { p1: row() }, bans: ["p9"] });
  });
  it("a ghost row has no peerId", () => {
    const ghost = { name: "G", joinedAt: 1, link: "reconnecting", goneAt: 5 };
    expect(schemas.state.parse({ entries: { p1: ghost }, bans: [] })).toBeDefined();
  });
  it("rejects too many entries, a long name and an unknown link state", () => {
    expect(
      schemas.state.parse({ entries: { a: row(), b: row(), c: row() }, bans: [] })
    ).toBeUndefined();
    expect(
      schemas.state.parse({ entries: { a: row({ name: "toolong" }) }, bans: [] })
    ).toBeUndefined();
    expect(
      schemas.state.parse({ entries: { a: row({ link: "weird" }) }, bans: [] })
    ).toBeUndefined();
  });
  it("bans: invalid ids are dropped, too many are rejected", () => {
    expect(schemas.state.parse({ entries: {}, bans: ["", "p1"] })?.bans).toEqual(["p1"]);
    expect(schemas.state.parse({ entries: {}, bans: ["a", "b", "c"] })).toBeUndefined();
  });
});

describe("roster command schemas", () => {
  it("join and rename need a name of 1..max", () => {
    expect(schemas.commands.join.parse({ type: "join", name: "Ann" })).toBeDefined();
    expect(schemas.commands.join.parse({ type: "join", name: "" })).toBeUndefined();
    expect(schemas.commands.rename.parse({ type: "rename", name: "toolong" })).toBeUndefined();
  });
  it("sync accepts up to twice the capacity of keys", () => {
    const links = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, "active"]));
    expect(schemas.commands.sync.parse({ type: "sync", links: links(4) })).toBeDefined();
    expect(schemas.commands.sync.parse({ type: "sync", links: links(5) })).toBeUndefined();
    expect(schemas.commands.sync.parse({ type: "sync", links: { p: "nope" } })).toBeUndefined();
  });
  it("remove, ban and unban need a player id", () => {
    for (const type of ["remove", "ban", "unban"] as const) {
      expect(schemas[`commands`][type].parse({ type, playerId: "p1" })).toBeDefined();
      expect(schemas.commands[type].parse({ type })).toBeUndefined();
    }
  });
});

describe("roster event schema", () => {
  it("ping and pong carry a nonce", () => {
    expect(schemas.event.parse({ kind: "ping", nonce: "n" })).toEqual({ kind: "ping", nonce: "n" });
    expect(schemas.event.parse({ kind: "pong", nonce: "n" })).toBeDefined();
    expect(schemas.event.parse({ kind: "ping", nonce: "" })).toBeUndefined();
    expect(schemas.event.parse({ kind: "hello", nonce: "n" })).toBeUndefined();
  });
});
