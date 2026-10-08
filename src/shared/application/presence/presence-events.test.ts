import { describe, expect, it } from "vitest";
import { parsePresenceEvent } from "./presence-events";

describe("parsePresenceEvent", () => {
  it("keeps valid status entries and drops invalid ones", () => {
    const e = parsePresenceEvent({
      t: "status",
      presence: {
        a: { status: "active", returning: true },
        b: { status: "weird", returning: false },
        c: { status: "active" },
      },
    });
    expect(e).toEqual({ t: "status", presence: { a: { status: "active", returning: true } } });
  });
  it("rejects a non-object or array presence map", () => {
    expect(parsePresenceEvent({ t: "status", presence: [] })).toBeUndefined();
    expect(parsePresenceEvent({ t: "status" })).toBeUndefined();
  });
  it("ping/pong need a string nonce", () => {
    expect(parsePresenceEvent({ t: "ping", nonce: "n" })).toEqual({ t: "ping", nonce: "n" });
    expect(parsePresenceEvent({ t: "pong", nonce: 1 })).toBeUndefined();
  });
  it("duplicate needs three strings", () => {
    const ok = { t: "duplicate", playerId: "p", oldPeerId: "o", newPeerId: "n" };
    expect(parsePresenceEvent(ok)).toEqual(ok);
    expect(parsePresenceEvent({ ...ok, newPeerId: 1 })).toBeUndefined();
  });
  it("restore needs object metadata; farewell needs a playerId", () => {
    expect(parsePresenceEvent({ t: "restore", metadata: { x: 1 } })).toEqual({
      t: "restore",
      metadata: { x: 1 },
    });
    expect(parsePresenceEvent({ t: "restore", metadata: [] })).toBeUndefined();
    expect(parsePresenceEvent({ t: "farewell" })).toBeUndefined();
  });
  it("rejects unknown types and non-objects", () => {
    expect(parsePresenceEvent({ t: "nope" })).toBeUndefined();
    expect(parsePresenceEvent("x")).toBeUndefined();
    expect(parsePresenceEvent({ t: "hello" })).toEqual({ t: "hello" });
  });
});
