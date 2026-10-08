import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, Emitter } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { FakeIds } from "@/shared/testing/fake-ids";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { RoomBus } from "./room-bus";
import type { BusTransport } from "./types";

class FakeTransport implements BusTransport {
  host = true;
  local = "a";
  hostId: string | undefined = "a";
  links = new Set<string>();
  expected: string[] = [];
  sent: Array<{ to: string; payload: unknown }> = [];
  broadcasts: unknown[] = [];
  private readonly messages = new Emitter<{ payload: unknown; from: string }>();
  private readonly hostChanged = new Emitter();

  getLocalPeerId() {
    return this.local;
  }
  getHostPeerId() {
    return this.hostId;
  }
  isHost() {
    return this.host;
  }
  send(to: string, payload: unknown) {
    this.sent.push({ to, payload });
  }
  broadcast(payload: unknown) {
    this.broadcasts.push(payload);
  }
  onMessage(handler: (payload: unknown, from: string) => void) {
    return this.messages.on(({ payload, from }) => handler(payload, from));
  }
  onHostChanged(handler: () => void) {
    return this.hostChanged.on(handler);
  }
  onLinkActive() {
    return () => {};
  }
  isLinkActive(id: string) {
    return this.links.has(id);
  }
  getExpectedPeerIds() {
    return this.expected;
  }
  deliver(payload: unknown, from: string) {
    this.messages.emit({ payload, from });
  }
  fireHostChanged() {
    this.hostChanged.emit();
  }
}

function setup(configure?: (t: FakeTransport) => void) {
  const transport = new FakeTransport();
  configure?.(transport);
  const logger = new RecordingLogger();
  const bus = new RoomBus({
    transport,
    clock: new FakeClock(),
    ids: new FakeIds(),
    logger,
    config: DEFAULT_CONFIG.bus,
  });
  const counter = bus.stateChannel<number>({
    id: "n",
    initial: 0,
    validate: (v) => (typeof v === "number" ? v : undefined),
  });
  counter.handle<number>("add", {
    validate: (p) => (typeof p === "number" ? p : undefined),
    reduce: (s, p) => ({ ok: true, state: s + p }),
  });
  return { transport, logger, bus, counter };
}

const stateWire = (rev: number, value: number) => ({
  __bus: 1,
  kind: "state",
  ch: "n",
  epoch: 1,
  rev,
  value,
  applied: {},
});
const cmd = (id: string, seq: number, payload: unknown) => ({
  __bus: 1,
  kind: "command",
  ch: "n",
  id,
  seq,
  type: "add",
  payload,
});
const asGuest = (t: FakeTransport) => {
  t.host = false;
  t.local = "g";
  t.hostId = "h";
  t.links.add("h");
};

describe("RoomBus as host", () => {
  it("becomes ready and publishes epoch 1", () => {
    const { bus, transport } = setup();
    bus.start();
    expect(bus.getStatus()).toBe("ready");
    expect(transport.broadcasts.at(-1)).toMatchObject({ kind: "state", ch: "n", epoch: 1 });
  });
  it("applies a local command", async () => {
    const { bus, counter } = setup();
    bus.start();
    await expect(counter.send("add", 2)).resolves.toEqual({ ok: true });
    expect(counter.get()).toBe(2);
  });
  it("applies a remote command once per (sender, seq)", () => {
    const { bus, transport, counter } = setup();
    bus.start();
    transport.deliver(cmd("c1", 1, 5), "g1");
    transport.deliver(cmd("c1", 1, 5), "g1");
    expect(counter.get()).toBe(5);
    expect(transport.sent).toHaveLength(2); // both are acked
    expect(transport.sent.at(-1)?.payload).toMatchObject({
      kind: "ack",
      id: "c1",
      result: { ok: true },
    });
  });
  it("rejects an invalid payload without changing state", () => {
    const { bus, transport, counter } = setup();
    bus.start();
    transport.deliver(cmd("c1", 1, "x"), "g1");
    expect(counter.get()).toBe(0);
    expect(transport.sent.at(-1)?.payload).toMatchObject({
      result: { ok: false, reason: "invalid-payload" },
    });
  });
});

describe("RoomBus as guest", () => {
  it("asks for a snapshot and stays syncing", () => {
    const { bus, transport } = setup(asGuest);
    bus.start();
    expect(bus.getStatus()).toBe("syncing");
    expect(transport.sent.map((m) => m.payload)).toContainEqual({
      __bus: 1,
      kind: "sync",
      ch: "n",
    });
  });
  it("ignores state from a peer that is not the host", () => {
    const { bus, transport, counter } = setup(asGuest);
    bus.start();
    transport.deliver(stateWire(3, 7), "x");
    expect(counter.get()).toBe(0);
    expect(bus.getStatus()).toBe("syncing");
  });
  it("adopts state from the host and becomes ready", () => {
    const { bus, transport, counter } = setup(asGuest);
    bus.start();
    transport.deliver(stateWire(3, 7), "h");
    expect(counter.get()).toBe(7);
    expect(bus.getStatus()).toBe("ready");
  });
  it("keeps synced state when the same host is announced again", () => {
    const { bus, transport, counter } = setup(asGuest);
    bus.start();
    transport.deliver(stateWire(3, 7), "h");
    transport.fireHostChanged();
    expect(counter.get()).toBe(7);
    expect(bus.getStatus()).toBe("ready");
  });
});

describe("RoomBus logging", () => {
  // Red until the step 3 edit is applied.
  it("warns about an invalid wire message", () => {
    const { bus, transport, logger } = setup();
    bus.start();
    transport.deliver({ nonsense: true }, "g1");
    expect(logger.messages("warn")).toContain("Dropped invalid wire message");
  });
});
