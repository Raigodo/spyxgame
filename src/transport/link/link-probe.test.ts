import { describe, expect, it } from "vitest";
import { FakeClock, RecordingLogger } from "@/kernel/fakes";
import { linkConfig } from "../config";
import { LinkProbe, PROBE_PING, PROBE_PONG, classifyProbe, decideProbe } from "./link-probe";

describe("classifyProbe", () => {
  it("recognises exact control strings only", () => {
    expect(classifyProbe(PROBE_PING)).toBe("ping");
    expect(classifyProbe(PROBE_PONG)).toBe("pong");
    expect(classifyProbe(`${PROBE_PING} `)).toBeUndefined();
    expect(classifyProbe('{"x":1}')).toBeUndefined();
  });
});

describe("decideProbe", () => {
  const base = { idleMs: 10_000, timeoutMs: 5_000 };
  it("pings after idle, waits otherwise", () => {
    expect(decideProbe({ ...base, now: 9_999, lastInbound: 0 })).toBe("none");
    expect(decideProbe({ ...base, now: 10_000, lastInbound: 0 })).toBe("ping");
  });
  it("with a ping outstanding: waits, then declares dead", () => {
    const a = { ...base, lastInbound: 0, pingSentAt: 10_000 };
    expect(decideProbe({ ...a, now: 14_999 })).toBe("none");
    expect(decideProbe({ ...a, now: 15_000 })).toBe("dead");
  });
  it("any inbound after the ping clears it", () => {
    expect(decideProbe({ ...base, now: 20_000, lastInbound: 12_000, pingSentAt: 10_000 })).toBe(
      "none"
    );
  });
});

describe("LinkProbe", () => {
  function make(active = true) {
    const clock = new FakeClock();
    const sent: string[] = [];
    let dead = 0;
    const probe = new LinkProbe({
      clock,
      config: linkConfig.defaults,
      logger: new RecordingLogger(),
      isActive: () => active,
      send: (t) => sent.push(t),
      onDead: () => dead++,
    });
    return { clock, sent, probe, dead: () => dead };
  }

  it("pings after the idle time, then reports dead after the timeout", () => {
    const { clock, sent, dead } = make();
    clock.advance(10_000);
    expect(sent).toEqual([PROBE_PING]);
    clock.advance(5_000);
    expect(dead()).toBe(1);
    clock.advance(60_000);
    expect(dead()).toBe(1); // stopped
  });
  it("inbound traffic keeps the link alive", () => {
    const { clock, sent, probe } = make();
    clock.advance(9_000);
    probe.noteInbound();
    clock.advance(1_000);
    expect(sent).toEqual([]);
  });
  it("a pong (any inbound) after a ping prevents the dead verdict", () => {
    const { clock, probe, dead } = make();
    clock.advance(10_000);
    probe.noteInbound();
    clock.advance(5_000);
    expect(dead()).toBe(0);
  });
  it("a guest (inactive) never probes; stop cancels", () => {
    const guest = make(false);
    guest.clock.advance(60_000);
    expect(guest.sent).toEqual([]);
    const host = make();
    host.probe.stop();
    host.clock.advance(60_000);
    expect(host.sent).toEqual([]);
  });
});
