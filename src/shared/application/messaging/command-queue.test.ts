import { describe, expect, it } from "vitest";
import { FakeClock } from "@/shared/testing/fake-clock";
import { CommandQueue, type QueuedCommand } from "./command-queue";

const cmd = (id: string, seq = 1): QueuedCommand => ({
  id,
  seq,
  ch: "c",
  type: "t",
  payload: null,
});

describe("CommandQueue", () => {
  it("resolves on ack and removes the entry", async () => {
    const q = new CommandQueue(new FakeClock());
    const p = q.enqueue(cmd("1"), 100);
    q.ack("1", { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(q.size).toBe(0);
  });
  it("expires after the TTL", async () => {
    const clock = new FakeClock();
    const q = new CommandQueue(clock);
    const p = q.enqueue(cmd("1"), 100);
    clock.advance(100);
    await expect(p).resolves.toMatchObject({ ok: false, kind: "expired" });
  });
  it("rejectAll resolves everything as left", async () => {
    const q = new CommandQueue(new FakeClock());
    const a = q.enqueue(cmd("1"), 100);
    const b = q.enqueue(cmd("2", 2), 100);
    q.rejectAll("bye");
    await expect(a).resolves.toMatchObject({ kind: "left" });
    await expect(b).resolves.toMatchObject({ kind: "left" });
  });
  it("keeps sequence order and resetRouting clears sentTo", () => {
    const q = new CommandQueue(new FakeClock());
    void q.enqueue(cmd("1", 1), 100);
    void q.enqueue(cmd("2", 2), 100);
    q.markSent("1", "host");
    expect(q.pending().map((c) => c.id)).toEqual(["1", "2"]);
    q.resetRouting();
    expect(q.pending().every((c) => c.sentTo === undefined)).toBe(true);
  });
});
