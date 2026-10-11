import { describe, expect, it } from "vitest";
import { RoomHarness } from "@/shared/testing/room-harness";
import { classifyProbe, decideProbe, PROBE_PING, PROBE_PONG } from "./link-probe";

const base = { now: 0, lastInbound: 0, idleMs: 10_000, timeoutMs: 5_000 };

describe("decideProbe", () => {
  it("does nothing while traffic is recent, pings after the idle time", () => {
    expect(decideProbe({ ...base, now: 9_999 })).toBe("none");
    expect(decideProbe({ ...base, now: 10_000 })).toBe("ping");
  });
  it("waits for the answer, then declares the link dead", () => {
    const sent = { ...base, pingSentAt: 10_000 };
    expect(decideProbe({ ...sent, now: 14_999 })).toBe("none");
    expect(decideProbe({ ...sent, now: 15_000 })).toBe("dead");
  });
  it("an answer after the ping resets the cycle", () => {
    expect(decideProbe({ ...base, pingSentAt: 10_000, lastInbound: 12_000, now: 16_000 })).toBe(
      "none"
    );
  });
});

it("classifies only the exact control strings", () => {
  expect(classifyProbe(PROBE_PING)).toBe("ping");
  expect(classifyProbe(PROBE_PONG)).toBe("pong");
  expect(classifyProbe('{"__probe":"ping","x":1}')).toBeUndefined();
});

describe("probe on the harness", () => {
  it("leaves a healthy idle link alone", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, "room1");
    await h.join(b, "room1");
    await h.advance(60_000);
    expect(h.logger.messages("warn").some((m) => m.includes("silent"))).toBe(false);
    expect(a.client.getPlayers()).toHaveLength(2);
  });

  it("a silent guest link is declared dead and re-established, and the host stays host", async () => {
    const h = new RoomHarness();
    const a = h.addClient("a");
    const b = h.addClient("b");
    await h.join(a, "room1");
    await h.join(b, "room1");
    b.silence();
    await h.advance(40_000);
    expect(h.logger.messages("warn").some((m) => m.includes("silent"))).toBe(true);
    expect(a.client.isHost()).toBe(true);
    expect(a.client.getPlayers()).toHaveLength(2);
  });
});
