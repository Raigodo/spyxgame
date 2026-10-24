import { describe, expect, it } from "vitest";
import type { DropReason, Wire } from "./model";
import { TransportHarness } from "./fakes";

const ROOM = "room1";

function collect(t: {
  messages: { on(fn: (v: { from: string; msg: Wire }) => void): () => void };
}) {
  const got: Array<{ from: string; msg: Wire }> = [];
  t.messages.on((m) => got.push(m));
  return got;
}

describe("transport: two peers", () => {
  it("join, hello binding, direct and broadcast messages, and a chunked message", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    const ta = await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);
    const atA = collect(ta);
    const atB = collect(tb);

    expect(ta.role.get()).toBe("host");
    expect(tb.role.get()).toBe("guest");
    expect(ta.members.get().get(tb.self)?.playerId).toBe(b.playerId); // verified hello
    expect(tb.links.get().size).toBe(1); // a guest sees only its host link

    ta.broadcast({ hi: 1 });
    tb.send(ta.self, "direct");
    const big = "x".repeat(50_000);
    ta.send(tb.self, big);
    await h.settle();

    expect(atB.map((m) => m.msg)).toEqual([{ hi: 1 }, big]);
    expect(atA).toEqual([{ from: tb.self, msg: "direct" }]); // no echo, from is verified
  });
});

describe("transport: failover", () => {
  it("when the host dies, the guest becomes host", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);
    const deadId = a.transport?.self;

    a.kill(1_000);
    await h.advance(20_000);

    expect(tb.role.get()).toBe("host");
    expect(tb.host.get()).toBe(tb.self);
    expect(deadId && tb.members.get().has(deadId)).toBe(false);
  });

  it("a refreshed host reclaims the seat, the guest does not", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);

    const a2 = await h.refresh(a, ROOM);
    await h.advance(15_000);

    expect(a2.transport?.role.get()).toBe("host");
    expect(tb.role.get()).toBe("guest");
  });
});

describe("transport: drop", () => {
  it("a dropped guest is told why, leaves, and is removed from membership", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    const ta = await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);
    const told: DropReason[] = [];
    tb.dropped.on((r) => told.push(r));

    const dropping = ta.drop(tb.self, "kicked");
    await h.advance(2_000);
    await dropping;

    expect(told).toEqual(["kicked"]);
    expect(ta.members.get().has(tb.self)).toBe(false);
    expect(ta.role.get()).toBe("host"); // the guest started no election
    expect(h.firestore.room(ROOM).host?.signalingPeerId).toBe(ta.self);
  });
});

describe("transport: leave, hand-off, size guard", () => {
  it("a guest that leaves disappears from the host's members", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    const ta = await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);
    await tb.leave();
    await tb.leave(); // idempotent
    await h.advance(1_000);
    expect(ta.members.get().has(tb.self)).toBe(false);
    expect(ta.role.get()).toBe("host");
  });

  it("handOff gives the seat to the guest", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    const ta = await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);
    const result = await ta.handOff(tb.self);
    await h.advance(2_000);
    expect(result.ok).toBe(true);
    expect(tb.role.get()).toBe("host");
    expect(ta.role.get()).toBe("guest");
  });

  it("handOff from a guest is refused", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    const ta = await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);
    const result = await tb.handOff(ta.self);
    expect(result).toEqual({ ok: false, reason: "not-host" });
  });

  it("an oversize message is refused at the sender", async () => {
    const h = new TransportHarness();
    const a = h.addPeer("a");
    const b = h.addPeer("b");
    const ta = await h.join(a, ROOM);
    const tb = await h.join(b, ROOM);
    const atB = collect(tb);
    ta.send(tb.self, "x".repeat(12_000 * 256 + 10));
    await h.settle();
    expect(atB).toEqual([]);
    expect(h.logger.messages("warn")).toContain("Refused to send an oversize message");
  });
});
