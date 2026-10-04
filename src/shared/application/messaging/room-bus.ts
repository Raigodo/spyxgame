// application/messaging/room-bus.ts

import { CommandQueue, type QueuedCommand } from "./command-queue";
import type {
  BusOptions,
  BusStatus,
  BusTransport,
  CommandResult,
  CommandSpec,
  EventChannelOptions,
  PeerId,
  StateChannelOptions,
} from "./types";
import { parseWire, type ChannelCopy, type Wire } from "./wire";

type ErasedHandler<S> = (args: {
  from: PeerId;
  isHostSender: boolean;
  state: S;
  payload: unknown;
  playerId?: string;
}) => { ok: true; state: S } | { ok: false; reason: string };

const DEFAULT_OPTIONS: BusOptions = {
  commandTtlMs: 30_000,
  recoveryWindowMs: 3_000,
  recoveryMaxMs: 10_000,
};

const cmp = (a: { epoch: number; rev: number }, b: { epoch: number; rev: number }) =>
  a.epoch - b.epoch || a.rev - b.rev;

/** What channels need from the bus (not part of the public API). */
interface ChannelHost {
  readonly transport: BusTransport;
  canPublish(): boolean;
  sendCommand(ch: string, type: string, payload: unknown): Promise<CommandResult>;
  broadcast(wire: Wire): void;
  sendTo(to: PeerId, wire: Wire): void;
  statusMayHaveChanged(): void;
}

interface BusStateChannel {
  readonly id: string;
  isSynced(): boolean;
  markUnsynced(): void;
  copy(): ChannelCopy;
  acceptState(c: ChannelCopy): void;
  adoptIfNewer(c: ChannelCopy): void;
  promote(): void;
  sendSnapshot(to: PeerId): void;
  execute(from: PeerId, seq: number, type: string, payload: unknown): CommandResult;
}

interface BusEventChannel {
  readonly id: string;
  receive(raw: unknown, from: PeerId): void;
}

// ─── StateChannel ───────────────────────────────────────────────────────────
// Host-owned replicated value, versioned by (epoch, rev). Guests accept only
// newer versions from the current host. Mutated on the host through commands
// (pure reducers) or publish().

export class StateChannel<S> implements BusStateChannel {
  private epoch = 0;
  private rev = 0;
  private value: S;
  private applied: Record<PeerId, number> = {};
  private synced = false;
  private readonly listeners = new Set<(value: S, prev: S) => void>();
  private readonly handlers = new Map<string, ErasedHandler<S>>();

  /** @internal use RoomBus.stateChannel() */
  constructor(
    private readonly host: ChannelHost,
    readonly id: string,
    private readonly opts: StateChannelOptions<S>
  ) {
    this.value = opts.initial;
  }

  get(): S {
    return this.value;
  }

  onChange(handler: (value: S, prev: S) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Registers a command type. Handlers run on whichever peer is host. */
  handle<P>(type: string, spec: CommandSpec<S, P>): void {
    this.handlers.set(type, ({ from, isHostSender, state, payload, playerId }) => {
      if (spec.hostOnly && !isHostSender) return { ok: false, reason: "host-only" };
      const parsed = spec.validate(payload);
      if (parsed === undefined) return { ok: false, reason: "invalid-payload" };
      const denied = spec.authorize?.({ from, state, isHostSender, playerId });
      if (denied) return { ok: false, reason: denied };
      return spec.reduce(state, parsed, { from, playerId });
    });
  }

  send<P>(type: string, payload: P): Promise<CommandResult> {
    return this.host.sendCommand(this.id, type, payload);
  }

  /** Host only. Prefer commands; publish() is for host-originated changes. */
  publish(next: S): void {
    if (!this.host.canPublish()) {
      throw new Error(`[StateChannel:${this.id}] publish() requires a ready host.`);
    }
    this.commit(next);
  }

  // ── internal (used by RoomBus) ──

  /** @internal */ isSynced(): boolean {
    return this.synced;
  }
  /** @internal */ markUnsynced(): void {
    this.synced = false;
  }

  /** @internal */
  copy(): ChannelCopy {
    return {
      ch: this.id,
      epoch: this.epoch,
      rev: this.rev,
      value: this.value,
      applied: { ...this.applied },
    };
  }

  /** @internal Guest: accept a snapshot/update from the current host. */
  acceptState(c: ChannelCopy): void {
    const value = this.opts.validate(c.value);
    if (value === undefined) return;
    const order = cmp(c, this.version());
    if (order < 0) return; // stale or from a demoted host
    this.synced = true;
    if (order === 0) return; // identical version: just confirms we are in sync
    this.adopt(c, value);
  }

  /** @internal Host: adopt the best offered copy during recovery. */
  adoptIfNewer(c: ChannelCopy): void {
    if (cmp(c, this.version()) <= 0) return;
    const value = this.opts.validate(c.value);
    if (value !== undefined) this.adopt(c, value);
  }

  /** @internal Host: start a new epoch and tell everyone. */
  promote(): void {
    this.epoch += 1;
    this.rev = 0;
    this.synced = true;
    this.host.broadcast(this.stateWire());
  }

  /** @internal */
  sendSnapshot(to: PeerId): void {
    this.host.sendTo(to, this.stateWire());
  }

  /** @internal Host: apply a command exactly once per (sender, seq). */
  execute(from: PeerId, seq: number, type: string, payload: unknown): CommandResult {
    if (seq <= (this.applied[from] ?? 0)) return { ok: true }; // duplicate re-send

    const handler = this.handlers.get(type);
    const out: ReturnType<ErasedHandler<S>> = handler
      ? handler({
          from,
          isHostSender: from === this.host.transport.getLocalPeerId(),
          state: this.value,
          payload,
          playerId: this.opts.resolveSender?.(from),
        })
      : { ok: false, reason: "unknown-command" };

    this.applied[from] = seq; // accepted or rejected, never re-run
    if (!out.ok) return { ok: false, kind: "rejected", reason: out.reason };

    this.commit(out.state); // applied[] is replicated in the same commit
    return { ok: true };
  }

  private version(): { epoch: number; rev: number } {
    return { epoch: this.epoch, rev: this.rev };
  }

  private commit(next: S): void {
    const prev = this.value;
    this.value = next;
    this.rev += 1;
    this.synced = true;
    this.host.broadcast(this.stateWire());
    this.emit(next, prev);
  }

  private adopt(c: ChannelCopy, value: S): void {
    const prev = this.value;
    this.epoch = c.epoch;
    this.rev = c.rev;
    this.applied = { ...c.applied };
    this.value = value;
    this.emit(value, prev);
  }

  private emit(value: S, prev: S): void {
    for (const handler of this.listeners) handler(value, prev);
  }

  private stateWire(): Wire {
    return { __bus: 1, kind: "state", ...this.copy() };
  }
}

// ─── EventChannel ───────────────────────────────────────────────────────────
// Ephemeral: no versioning, no replay. Delivered locally to the sender too,
// so callers don't need to special-case their own messages.

export class EventChannel<E> implements BusEventChannel {
  private readonly listeners = new Set<(event: E, from: PeerId) => void>();

  /** @internal use RoomBus.eventChannel() */
  constructor(
    private readonly host: ChannelHost,
    readonly id: string,
    private readonly opts: EventChannelOptions<E>
  ) {}

  onEvent(handler: (event: E, from: PeerId) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  broadcast(event: E): void {
    this.host.broadcast({ __bus: 1, kind: "event", ch: this.id, event });
    this.deliverLocal(event);
  }

  sendTo(peerId: PeerId, event: E): void {
    if (peerId === this.host.transport.getLocalPeerId()) return this.deliverLocal(event);
    this.host.sendTo(peerId, { __bus: 1, kind: "event", ch: this.id, event });
  }

  /** @internal */
  receive(raw: unknown, from: PeerId): void {
    const event = this.opts.validate(raw);
    if (event !== undefined) for (const h of this.listeners) h(event, from);
  }

  private deliverLocal(event: E): void {
    const from = this.host.transport.getLocalPeerId();
    if (from) for (const h of this.listeners) h(event, from);
  }
}

// ─── RoomBus ────────────────────────────────────────────────────────────────

interface Recovery {
  best: Map<string, ChannelCopy>;
  offeredBy: Set<PeerId>;
  slideTimer?: ReturnType<typeof setTimeout>;
  maxTimer: ReturnType<typeof setTimeout>;
  held: Array<{ w: Extract<Wire, { kind: "command" }>; from: PeerId }>;
}

export class RoomBus {
  private readonly options: BusOptions;
  private readonly stateChannels = new Map<string, BusStateChannel>();
  private readonly eventChannels = new Map<string, BusEventChannel>();
  private readonly queue = new CommandQueue();
  private readonly statusHandlers = new Set<(status: BusStatus) => void>();
  private readonly cleanups: Array<() => void> = [];

  private status: BusStatus = "syncing";
  private started = false;
  private wasHost = false;
  private recovery?: Recovery;
  private seq = 0;

  constructor(
    private readonly transport: BusTransport,
    options: Partial<BusOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ─── Channels ─────────────────────────────────────────────────────────────

  stateChannel<S>(opts: StateChannelOptions<S>): StateChannel<S> {
    if (this.stateChannels.has(opts.id))
      throw new Error(`[RoomBus] Duplicate channel "${opts.id}".`);
    const channel = new StateChannel<S>(this.channelHost, opts.id, opts);
    this.stateChannels.set(opts.id, channel);

    if (this.started) this.bootstrapLateChannel(channel); // registered after start()
    return channel;
  }

  eventChannel<E>(opts: EventChannelOptions<E>): EventChannel<E> {
    if (this.eventChannels.has(opts.id))
      throw new Error(`[RoomBus] Duplicate channel "${opts.id}".`);
    const channel = new EventChannel<E>(this.channelHost, opts.id, opts);
    this.eventChannels.set(opts.id, channel);
    return channel;
  }

  // ─── Lifecycle / status ───────────────────────────────────────────────────

  /** Call once the session is joined. Register channels before this when possible. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.cleanups.push(
      this.transport.onMessage((payload, from) => this.handleWire(payload, from)),
      this.transport.onHostChanged(() => this.handleHostChanged()),
      this.transport.onLinkActive((peerId) => this.handleLinkActive(peerId))
    );
    this.handleHostChanged();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.endRecovery();
    this.queue.rejectAll("client left");
    this.statusHandlers.clear();
  }

  getStatus(): BusStatus {
    return this.status;
  }

  onStatusChanged(handler: (status: BusStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  // ─── Internals exposed to channels ────────────────────────────────────────

  private readonly channelHost: ChannelHost = {
    transport: this.transport,
    canPublish: () => this.transport.isHost() && !this.recovery,
    sendCommand: (ch, type, payload) => this.sendCommand(ch, type, payload),
    broadcast: (wire) => this.transport.broadcast(wire),
    sendTo: (to, wire) => this.transport.send(to, wire),
    statusMayHaveChanged: () => this.refreshStatus(),
  };

  private sendCommand(ch: string, type: string, payload: unknown): Promise<CommandResult> {
    const cmd: QueuedCommand = { id: crypto.randomUUID(), seq: ++this.seq, ch, type, payload };
    const result = this.queue.enqueue(cmd, this.options.commandTtlMs);
    this.flushQueue();
    return result;
  }

  // ─── Incoming ─────────────────────────────────────────────────────────────

  private handleWire(payload: unknown, from: PeerId): void {
    if (from === this.transport.getLocalPeerId()) return; // own broadcast echoed back
    const w = parseWire(payload);
    if (!w) return;

    const hostId = this.transport.getHostPeerId();
    const iAmHost = this.transport.isHost();

    switch (w.kind) {
      case "state":
        if (from !== hostId || iAmHost) return;
        this.stateChannels.get(w.ch)?.acceptState(w);
        this.refreshStatus();
        break;
      case "ack":
        if (from === hostId) this.queue.ack(w.id, w.result);
        break;
      case "event":
        this.eventChannels.get(w.ch)?.receive(w.event, from);
        break;
      case "offer":
        if (iAmHost && this.recovery) this.recordOffer(from, w.channels);
        break;
      case "sync":
        if (iAmHost && !this.recovery) this.stateChannels.get(w.ch)?.sendSnapshot(from);
        break;
      case "command":
        if (!iAmHost) return; // stale routing; the sender re-sends after it learns the host
        if (this.recovery) this.recovery.held.push({ w, from });
        else this.processRemoteCommand(w, from);
        break;
    }
  }

  private processRemoteCommand(w: Extract<Wire, { kind: "command" }>, from: PeerId): void {
    const result = this.execute(from, w.ch, w.seq, w.type, w.payload);
    this.transport.send(from, { __bus: 1, kind: "ack", id: w.id, result });
  }

  private execute(
    from: PeerId,
    ch: string,
    seq: number,
    type: string,
    payload: unknown
  ): CommandResult {
    const channel = this.stateChannels.get(ch);
    if (!channel) return { ok: false, kind: "rejected", reason: "unknown-channel" };
    return channel.execute(from, seq, type, payload);
  }

  // ─── Routing: who is host, is the link up ─────────────────────────────────

  private handleHostChanged(): void {
    const iAmHost = this.transport.isHost();
    const promoted = iAmHost && !this.wasHost;
    const demoted = !iAmHost && this.wasHost;
    this.wasHost = iAmHost;

    if (demoted) this.endRecovery();
    if (promoted) this.beginRecovery();
    if (!iAmHost) {
      for (const channel of this.stateChannels.values()) channel.markUnsynced();
      this.queue.resetRouting();
      this.syncWithHost();
    }
    this.flushQueue();
    this.refreshStatus();
  }

  private handleLinkActive(peerId: PeerId): void {
    if (this.transport.isHost()) {
      if (this.recovery) this.noteRecoveryActivity();
      else for (const channel of this.stateChannels.values()) channel.sendSnapshot(peerId);
    } else if (peerId === this.transport.getHostPeerId()) {
      this.syncWithHost();
    }
    this.refreshStatus();
  }

  /** Guest, link to host is up: offer our copies (matters after a promotion), flush commands. */
  private syncWithHost(): void {
    const hostId = this.transport.getHostPeerId();
    if (!hostId || this.transport.isHost() || !this.transport.isLinkActive(hostId)) return;
    const channels = Array.from(this.stateChannels.values(), (c) => c.copy());
    this.transport.send(hostId, { __bus: 1, kind: "offer", channels });
    this.flushQueue();
  }

  private flushQueue(): void {
    const hostId = this.transport.getHostPeerId();
    if (!hostId || !this.started) return;
    const iAmHost = this.transport.isHost();
    if (iAmHost ? !!this.recovery : !this.transport.isLinkActive(hostId)) return;

    for (const cmd of this.queue.pending()) {
      if (cmd.sentTo === hostId) continue;
      this.queue.markSent(cmd.id, hostId);
      if (iAmHost) {
        const local = this.transport.getLocalPeerId();
        if (local)
          this.queue.ack(cmd.id, this.execute(local, cmd.ch, cmd.seq, cmd.type, cmd.payload));
      } else {
        this.transport.send(hostId, {
          __bus: 1,
          kind: "command",
          ch: cmd.ch,
          id: cmd.id,
          seq: cmd.seq,
          type: cmd.type,
          payload: cmd.payload,
        });
      }
    }
  }

  private bootstrapLateChannel(channel: BusStateChannel): void {
    if (this.transport.isHost()) {
      if (!this.recovery) channel.promote(); // epoch 1, everyone gets the initial value
    } else {
      const hostId = this.transport.getHostPeerId();
      if (hostId && this.transport.isLinkActive(hostId)) {
        this.transport.send(hostId, { __bus: 1, kind: "sync", ch: channel.id });
      }
    }
    this.refreshStatus();
  }

  // ─── Promotion recovery ───────────────────────────────────────────────────
  // A new host may be a freshly refreshed tab with empty state. Before it
  // publishes anything, it asks (implicitly: guests offer when their link comes
  // up) for every guest's copy and adopts the newest.

  private beginRecovery(): void {
    this.endRecovery();
    this.recovery = {
      best: new Map(),
      offeredBy: new Set(),
      held: [],
      maxTimer: setTimeout(() => this.finishRecovery(), this.options.recoveryMaxMs),
    };
    this.checkRecoveryComplete();
  }

  private recordOffer(from: PeerId, channels: ChannelCopy[]): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.offeredBy.add(from);
    for (const copy of channels) {
      const prior = recovery.best.get(copy.ch);
      if (!prior || cmp(copy, prior) > 0) recovery.best.set(copy.ch, copy);
    }
    this.noteRecoveryActivity();
  }

  private noteRecoveryActivity(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    clearTimeout(recovery.slideTimer);
    recovery.slideTimer = setTimeout(() => this.finishRecovery(), this.options.recoveryWindowMs);
    this.checkRecoveryComplete();
  }

  private checkRecoveryComplete(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    const expected = this.transport.getExpectedPeerIds();
    if (expected.every((id) => recovery.offeredBy.has(id))) this.finishRecovery();
  }

  private finishRecovery(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    this.recovery = undefined; // before publishing, so canPublish() is true
    clearTimeout(recovery.slideTimer);
    clearTimeout(recovery.maxTimer);

    for (const channel of this.stateChannels.values()) {
      const offered = recovery.best.get(channel.id);
      if (offered) channel.adoptIfNewer(offered);
      channel.promote();
    }
    for (const { w, from } of recovery.held) this.processRemoteCommand(w, from);
    this.flushQueue();
    this.refreshStatus();
  }

  private endRecovery(): void {
    if (!this.recovery) return;
    clearTimeout(this.recovery.slideTimer);
    clearTimeout(this.recovery.maxTimer);
    this.recovery = undefined;
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  private computeStatus(): BusStatus {
    if (!this.started) return "syncing";
    if (this.transport.isHost()) return this.recovery ? "syncing" : "ready";
    const hostId = this.transport.getHostPeerId();
    if (!hostId || !this.transport.isLinkActive(hostId)) return "syncing";
    for (const channel of this.stateChannels.values()) if (!channel.isSynced()) return "syncing";
    return "ready";
  }

  private refreshStatus(): void {
    const next = this.computeStatus();
    if (next === this.status) return;
    this.status = next;
    for (const handler of this.statusHandlers) handler(next);
  }
}
