import { describe, expect, it } from "vitest";
import { as, type ChannelId, type PeerId } from "@/kernel";
import { FakeClock } from "@/kernel/fakes";
import { CommandQueue, type QueuedCommand } from "./queue";

const cmd = (id: string, seq: number): QueuedCommand => ({
  id,
  seq,
  ch: as<ChannelId>("c"),
  type: "t",
  payload: {},
});

const make = () => {
  const clock = new FakeClock();
  return { clock, q: new CommandQueue({ clock }) };
};

describe("CommandQueue", () => {
  it("resolves with the host's verdict and removes the entry", async () => {
    const { q } = make();
    const p = q.enqueue(cmd("a", 1), 1_000);
    expect(q.size).toBe(1);
    q.ack("a", { ok: true, value: undefined });
    expect(await p).toEqual({ ok: true, value: undefined });
    expect(q.size).toBe(0);
  });

  it("a rejection verdict carries the reason", async () => {
    const { q } = make();
    const p = q.enqueue(cmd("a", 1), 1_000);
    q.ack("a", { ok: false, reason: "nope" });
    expect(await p).toEqual({ ok: false, reason: "nope" });
  });

  it("expires after the ttl; a late ack is ignored", async () => {
    const { q, clock } = make();
    const p = q.enqueue(cmd("a", 1), 1_000);
    clock.advance(999);
    expect(q.size).toBe(1);
    clock.advance(1);
    expect(await p).toEqual({ ok: false, reason: "expired" });
    q.ack("a", { ok: true, value: undefined }); // no throw
    expect(q.size).toBe(0);
  });

  it("an ack cancels the ttl timer", async () => {
    const { q, clock } = make();
    const p = q.enqueue(cmd("a", 1), 1_000);
    q.ack("a", { ok: true, value: undefined });
    clock.advance(5_000);
    expect((await p).ok).toBe(true);
  });

  it("pending keeps sequence order; markSent and resetRouting", () => {
    const { q } = make();
    void q.enqueue(cmd("a", 1), 1_000);
    void q.enqueue(cmd("b", 2), 1_000);
    expect(q.pending().map((c) => c.id)).toEqual(["a", "b"]);
    q.markSent("a", as<PeerId>("host"));
    expect(q.pending()[0]?.sentTo).toBe("host");
    q.markSent("zzz", as<PeerId>("host")); // unknown: harmless
    q.resetRouting();
    expect(q.pending().every((c) => c.sentTo === undefined)).toBe(true);
  });

  it("rejectAll settles everything with `left`", async () => {
    const { q } = make();
    const p1 = q.enqueue(cmd("a", 1), 1_000);
    const p2 = q.enqueue(cmd("b", 2), 1_000);
    q.rejectAll();
    expect(await p1).toEqual({ ok: false, reason: "left" });
    expect(await p2).toEqual({ ok: false, reason: "left" });
    expect(q.size).toBe(0);
  });

  it("acking an unknown id is a no-op", () => {
    const { q } = make();
    expect(() => q.ack("nope", { ok: true, value: undefined })).not.toThrow();
  });
});
