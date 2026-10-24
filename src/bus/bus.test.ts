import { describe, expect, it } from "vitest";
import { Scope, as, fail, ok, s, type ChannelId, type PlayerId } from "@/kernel";
import { FakeClock, FakeIds, RecordingLogger, nextMacrotask } from "@/kernel/fakes";
import { DEFAULT_BUS_CONFIG, createBus, type BusConfig, type EventDef, type StateDef } from "@/bus";
import { FakeBusNetwork } from "@/bus/fakes";

// ─── Channels used by the scenarios ─────────────────────────────────────────

type CounterState = { n: number; note?: string };
type CounterCmd =
  | { type: "inc"; by: number }
  | { type: "nope" }
  | { type: "noop" }
  | { type: "grow" }
  | { type: "reset" }
  | { type: "setNote"; note: string };

const counterDef: StateDef<CounterState, CounterCmd, "nope"> = {
  id: as<ChannelId>("counter"),
  schema: s.object({ n: s.int({ min: 0, max: 1000 }), note: s.optional(s.string({ max: 500 })) }),
  init: { n: 0 },
  commands: {
    inc: {
      who: "anyone",
      schema: s.object({ type: s.literal("inc"), by: s.int({ min: 1, max: 10 }) }),
      reduce: (st, p) => ok({ state: { ...st, n: st.n + p.by } }),
    },
    nope: {
      who: "anyone",
      schema: s.object({ type: s.literal("nope") }),
      reduce: () => fail("nope"),
    },
    noop: {
      who: "anyone",
      schema: s.object({ type: s.literal("noop") }),
      reduce: (st) => ok({ state: st }),
    },
    grow: {
      who: "anyone",
      schema: s.object({ type: s.literal("grow") }),
      reduce: (st) => ok({ state: { ...st, n: 9_999 } }), // breaks the state schema
    },
    reset: {
      who: "host",
      schema: s.object({ type: s.literal("reset") }),
      reduce: (st) => ok({ state: { ...st, n: 0 } }),
    },
    setNote: {
      who: "anyone",
      schema: s.object({ type: s.literal("setNote"), note: s.string({ max: 500 }) }),
      reduce: (st, p) => ok({ state: { ...st, note: p.note } }),
    },
  },
};

const chatDef: EventDef<{ text: string }> = {
  id: as<ChannelId>("chat"),
  schema: s.object({ text: s.string({ max: 20 }) }),
};

type Vault = { round: number; rev: Record<string, number> };
type VaultCmd = { type: "give"; player: PlayerId; secret: string; rev: number };

const vaultDef: StateDef<Vault, VaultCmd, never> = {
  id: as<ChannelId>("vault"),
  schema: s.object({
    round: s.int({ min: 1, max: 10 }),
    rev: s.record(s.int({ min: 0, max: 100 }), { maxKeys: 10, onInvalid: "reject" }),
  }),
  init: { round: 1, rev: {} },
  commands: {
    give: {
      who: "host",
      schema: s.object({
        type: s.literal("give"),
        player: s.id("player"),
        secret: s.string({ max: 20 }),
        rev: s.int({ min: 1, max: 100 }),
      }),
      reduce: (st, p) =>
        ok({
          state: { ...st, rev: { ...st.rev, [p.player]: p.rev } },
          privateWrites: [{ playerId: p.player, round: st.round, rev: p.rev, value: p.secret }],
        }),
    },
  },
};

// ─── World ──────────────────────────────────────────────────────────────────

function world(opts: { config?: Partial<BusConfig> } = {}) {
  const net = new FakeBusNetwork();
  const clock = new FakeClock();
  const ids = new FakeIds();
  const log = new RecordingLogger();
  const config: BusConfig = { ...DEFAULT_BUS_CONFIG, ...opts.config };

  function add(name: string, o: { clock?: FakeClock } = {}) {
    const transport = net.addPeer(name);
    const scope = new Scope({ onError: (e) => log.error("Cleanup failed", e) });
    const bus = createBus(
      {
        transport,
        localPlayerId: as<PlayerId>(name),
        clock: o.clock ?? clock,
        ids,
        log: log.child(name),
        config,
      },
      scope
    );
    const counter = bus.state(counterDef);
    const chat = bus.events(chatDef);
    const vault = bus.state(vaultDef);
    const secret = bus.priv({
      id: as<ChannelId>("vault-private"),
      schema: s.string({ max: 20 }),
      of: vault,
      revisions: (st) => ({ round: st.round, rev: st.rev as Record<PlayerId, number> }),
    });
    bus.start();
    return { name, transport, scope, bus, counter, chat, vault, secret };
  }

  const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i++) await nextMacrotask();
  };
  const advance = async (ms: number, stepMs = 500) => {
    for (let left = ms; left > 0; left -= stepMs) {
      clock.advance(Math.min(stepMs, left));
      await settle(3);
    }
  };
  const stateMessages = () =>
    net.sent.filter((m) => (m.msg as { kind?: string }).kind === "state").length;

  return { net, clock, log, add, settle, advance, stateMessages };
}

type Peer = ReturnType<ReturnType<typeof world>["add"]>;

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe("bus: sync", () => {
  it("a guest has no value until synced, then converges with the host", async () => {
    const w = world();
    const a = w.add("a");
    await w.settle();
    expect(a.counter.value.get()).toEqual({ n: 0 });
    expect(a.bus.sync.get()).toBe("ready");

    const b = w.add("b");
    expect(b.counter.value.get()).toBeUndefined();
    expect(b.bus.sync.get()).toBe("syncing");
    await w.settle();
    expect(b.counter.value.get()).toEqual({ n: 0 });
    expect(b.counter.synced.get()).toBe(true);
    expect(b.bus.sync.get()).toBe("ready");
  });
});

describe("bus: commands", () => {
  async function two() {
    const w = world();
    const a = w.add("a");
    const b = w.add("b");
    await w.settle();
    return { w, a, b };
  }

  it("a guest command runs on the host and everyone converges", async () => {
    const { w, a, b } = await two();
    const p = b.counter.send({ type: "inc", by: 2 });
    await w.settle();
    expect((await p).ok).toBe(true);
    expect(a.counter.value.get()?.n).toBe(2);
    expect(b.counter.value.get()?.n).toBe(2);
  });

  it("host apply is synchronous and reaches guests", async () => {
    const { w, a, b } = await two();
    expect(a.counter.apply({ type: "inc", by: 1 }).ok).toBe(true);
    expect(a.counter.value.get()?.n).toBe(1);
    await w.settle();
    expect(b.counter.value.get()?.n).toBe(1);
  });

  it("rejections: reducer reason, host-only, invalid payload, unknown command", async () => {
    const { w, a, b } = await two();
    const nope = b.counter.send({ type: "nope" });
    const hostOnly = b.counter.send({ type: "reset" });
    const invalid = b.counter.send({ type: "inc", by: 999 });
    const unknown = b.counter.send({ type: "zzz" } as unknown as CounterCmd);
    await w.settle();
    expect(await nope).toEqual({ ok: false, reason: "nope" });
    expect(await hostOnly).toEqual({ ok: false, reason: "host-only" });
    expect(await invalid).toEqual({ ok: false, reason: "invalid" });
    expect(await unknown).toEqual({ ok: false, reason: "unknown-command" });
    expect(a.counter.value.get()?.n).toBe(0);
    expect(a.counter.apply({ type: "reset" }).ok).toBe(true);
  });

  it("a guest cannot apply", async () => {
    const { b } = await two();
    expect(b.counter.apply({ type: "inc", by: 1 })).toEqual({ ok: false, reason: "not-ready" });
  });

  it("a re-sent command runs exactly once", async () => {
    const { w, a, b } = await two();
    const p = b.counter.send({ type: "inc", by: 2 });
    await w.settle();
    await p;
    const original = w.net.sent.find(
      (m) => m.from === b.transport.self && (m.msg as { kind?: string }).kind === "command"
    );
    expect(original).toBeDefined();
    b.transport.send(a.transport.self, original!.msg);
    await w.settle();
    expect(a.counter.value.get()?.n).toBe(2);
    expect(b.counter.value.get()?.n).toBe(2);
  });

  it("a reducer returning the same state is a no-op: no state broadcast", async () => {
    const { w, a, b } = await two();
    const before = w.stateMessages();
    expect(a.counter.apply({ type: "noop" }).ok).toBe(true);
    const p = b.counter.send({ type: "noop" });
    await w.settle();
    expect((await p).ok).toBe(true);
    expect(w.stateMessages()).toBe(before);
  });

  it("a result that breaks the state schema is rejected and state is unchanged", async () => {
    const { w, a, b } = await two();
    const p = b.counter.send({ type: "grow" });
    await w.settle();
    expect(await p).toEqual({ ok: false, reason: "invalid" });
    expect(a.counter.apply({ type: "grow" })).toEqual({ ok: false, reason: "invalid" });
    expect(a.counter.value.get()?.n).toBe(0);
  });

  it("a result over the size cap is rejected too-large", async () => {
    const w = world({ config: { maxStateChars: 100 } });
    const a = w.add("a");
    await w.settle();
    expect(a.counter.apply({ type: "setNote", note: "x".repeat(200) })).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(a.counter.value.get()).toEqual({ n: 0 });
  });
});

describe("bus: events", () => {
  it("broadcast reaches everyone including the sender; a guest's broadcast is relayed", async () => {
    const w = world();
    const a = w.add("a");
    const b = w.add("b");
    const c = w.add("c");
    await w.settle();
    const got = { a: [] as string[], b: [] as string[], c: [] as string[] };
    const from: string[] = [];
    a.chat.events.on((e) => got.a.push(e.event.text));
    b.chat.events.on((e) => got.b.push(e.event.text));
    c.chat.events.on((e) => {
      got.c.push(e.event.text);
      from.push(e.from);
    });
    b.chat.broadcast({ text: "hi" });
    await w.settle();
    expect(got).toEqual({ a: ["hi"], b: ["hi"], c: ["hi"] });
    expect(from).toEqual(["b"]); // the true sender
  });

  it("sendTo reaches one peer; sendTo self is local", async () => {
    const w = world();
    const a = w.add("a");
    const b = w.add("b");
    await w.settle();
    const atA: string[] = [];
    const atB: string[] = [];
    a.chat.events.on((e) => atA.push(e.event.text));
    b.chat.events.on((e) => atB.push(e.event.text));
    a.chat.sendTo(b.transport.self, { text: "to-b" });
    a.chat.sendTo(a.transport.self, { text: "to-me" });
    await w.settle();
    expect(atB).toEqual(["to-b"]);
    expect(atA).toEqual(["to-me"]);
  });

  it("an invalid event or wire message is dropped and logged, nothing breaks", async () => {
    const w = world();
    const a = w.add("a");
    const b = w.add("b");
    await w.settle();
    const atB: unknown[] = [];
    b.chat.events.on((e) => atB.push(e.event));
    a.transport.broadcast({ __bus: 1, kind: "event", ch: "chat", event: { text: 123 } });
    a.transport.broadcast({ junk: true });
    await w.settle();
    expect(atB).toEqual([]);
    expect(w.log.messages("warn")).toContain("Dropped invalid wire message");
    expect(b.bus.sync.get()).toBe("ready");
  });
});

describe("bus: registration", () => {
  it("registering after start, a duplicate id, or a foreign `of` throws", () => {
    const w = world();
    const a = w.add("a");
    expect(() => a.bus.state(counterDef)).toThrow(/after start/);

    const transport = w.net.addPeer("x");
    const bus = createBus(
      {
        transport,
        localPlayerId: as<PlayerId>("x"),
        clock: w.clock,
        ids: new FakeIds(),
        log: new RecordingLogger(),
        config: DEFAULT_BUS_CONFIG,
      },
      new Scope({ onError: () => {} })
    );
    bus.state(counterDef);
    expect(() => bus.state(counterDef)).toThrow(/Duplicate/);
    expect(() =>
      bus.priv({
        id: as<ChannelId>("other-private"),
        schema: s.string({ max: 5 }),
        of: { value: { get: () => undefined, subscribe: () => () => {} } },
        revisions: () => undefined,
      })
    ).toThrow(/state handle/);
  });
});

describe("bus: lost host", () => {
  it("sync is `lost`; a pending command expires after the ttl", async () => {
    const w = world();
    w.add("a");
    const b = w.add("b");
    await w.settle();
    w.net.kill("a");
    await w.settle();
    expect(b.bus.sync.get()).toBe("lost");
    const p = b.counter.send({ type: "inc", by: 1 });
    await w.advance(DEFAULT_BUS_CONFIG.commandTtlMs + 1_000);
    expect(await p).toEqual({ ok: false, reason: "expired" });
  });

  it("disposing the bus resolves pending commands with `left`", async () => {
    const w = world();
    w.add("a");
    const b = w.add("b");
    await w.settle();
    w.net.kill("a");
    const p = b.counter.send({ type: "inc", by: 1 });
    b.scope.dispose();
    expect(await p).toEqual({ ok: false, reason: "left" });
  });
});

describe("bus: host time", () => {
  it("continues across hosts instead of jumping to the new host's clock", async () => {
    const w = world();
    const aClock = new FakeClock();
    aClock.advance(100_000);
    const bClock = new FakeClock();
    const a = w.add("a", { clock: aClock });
    const b = w.add("b", { clock: bClock });
    await w.settle();
    expect(a.bus.now()).toBe(100_000);
    expect(b.bus.now()).toBe(100_000);

    w.net.kill("a");
    w.net.removeMember("a");
    w.net.setHost("b");
    await w.settle();
    bClock.advance(5_000);
    expect(b.bus.now()).toBe(105_000);
  });
});

describe("bus: host change", () => {
  async function three() {
    const w = world();
    const a = w.add("a");
    const b = w.add("b");
    const c = w.add("c");
    await w.settle();
    return { w, a, b, c };
  }
  const failOver = async (w: ReturnType<typeof world>) => {
    w.net.kill("a");
    w.net.removeMember("a");
    w.net.setHost("b");
    await w.advance(5_000);
  };

  it("state survives, every peer is ready, and commands keep working", async () => {
    const { w, b, c } = await three();
    const p = c.counter.send({ type: "inc", by: 3 });
    await w.settle();
    await p;

    await failOver(w);
    expect(b.counter.value.get()?.n).toBe(3);
    expect(c.counter.value.get()?.n).toBe(3);
    expect(b.bus.sync.get()).toBe("ready");
    expect(c.bus.sync.get()).toBe("ready");

    const p2 = c.counter.send({ type: "inc", by: 1 });
    await w.settle();
    expect((await p2).ok).toBe(true);
    expect(b.counter.value.get()?.n).toBe(4);
    expect(c.counter.value.get()?.n).toBe(4);
  });

  it("commands in flight during the failover run exactly once", async () => {
    const { w, b, c } = await three();
    w.net.kill("a");
    const p1 = b.counter.send({ type: "inc", by: 5 });
    const p2 = c.counter.send({ type: "inc", by: 7 });
    w.net.removeMember("a");
    w.net.setHost("b");
    await w.advance(5_000);
    expect((await p1).ok).toBe(true);
    expect((await p2).ok).toBe(true);
    expect(b.counter.value.get()?.n).toBe(12);
    expect(c.counter.value.get()?.n).toBe(12);
  });
});

describe("bus: private pieces", () => {
  async function three() {
    const w = world();
    const a = w.add("a");
    const b = w.add("b");
    const c = w.add("c");
    await w.settle();
    return { w, a, b, c };
  }
  const give = (p: Peer, to: Peer, secret: string, rev: number) =>
    p.vault.apply({ type: "give", player: as<PlayerId>(to.name), secret, rev });

  it("a piece goes only to its owner; the host can read it", async () => {
    const { w, a, b, c } = await three();
    expect(give(a, b, "s3", 1).ok).toBe(true);
    await w.settle();
    expect(b.secret.mine.get()).toBe("s3");
    expect(c.secret.mine.get()).toBeUndefined();
    expect(a.secret.view(as<PlayerId>("b"))).toBe("s3");
    expect(a.secret.mine.get()).toBeUndefined();
  });

  it("a stale piece (revision no longer current) is not shown", async () => {
    const { w, a, b } = await three();
    give(a, b, "old", 1);
    await w.settle();
    expect(b.secret.mine.get()).toBe("old");
    give(a, b, "new", 2);
    await w.settle();
    expect(b.secret.mine.get()).toBe("new");
  });

  it("a new host recovers the piece from its owner", async () => {
    const { w, b, a, c } = await three();
    give(a, c, "keep", 1);
    await w.settle();

    w.net.kill("a");
    w.net.removeMember("a");
    w.net.setHost("b");
    await w.advance(5_000);

    expect(b.secret.view(as<PlayerId>("c"))).toBe("keep");
    expect(c.secret.mine.get()).toBe("keep");
  });
});
