import { BusRecovery, type RecoveryResult } from "./bus-recovery";
import { CommandQueue, type QueuedCommand } from "./command-queue";
import type { ChannelHost } from "./channel-host";
import { EventChannel, type BusEventChannel } from "./event-channel";
import { StateChannel, type BusStateChannel } from "./state-channel";
import type {
  BusOptions,
  BusStatus,
  BusTransport,
  CommandResult,
  EventChannelOptions,
  PeerId,
  StateChannelOptions,
} from "./types";
import { parseWire, type ChannelCopy, type Wire } from "./wire";
import {
  Emitter,
  createThrottledWarn,
  isRecord,
  type Cancel,
  type Clock,
  type IdGenerator,
  type Logger,
  type ThrottledWarn,
} from "@/shared/kernel";
import { computeBusStatus } from "./bus-rules";

/** One handler per wire kind. A new kind in `Wire` does not compile until it has one here. */
type WireHandlers = { [K in Wire["kind"]]: (w: Extract<Wire, { kind: K }>, from: PeerId) => void };

export interface RoomBusDeps {
  transport: BusTransport;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: BusOptions;
}

export class RoomBus {
  private readonly transport: BusTransport;
  private readonly options: BusOptions;
  private readonly stateChannels = new Map<string, BusStateChannel>();
  private readonly eventChannels = new Map<string, BusEventChannel>();
  private readonly queue: CommandQueue;
  private readonly statusChanged = new Emitter<BusStatus>();
  private readonly cleanups: Array<() => void> = [];
  private readonly channelHost: ChannelHost;
  private readonly warnInvalidWire: ThrottledWarn;

  private lastHostId?: PeerId;
  private cancelResync?: Cancel;

  private status: BusStatus = "syncing";
  private started = false;
  private wasHost = false;
  private recovery?: BusRecovery;
  private seq = 0;

  constructor(private readonly deps: RoomBusDeps) {
    this.transport = deps.transport;
    this.options = deps.config;
    this.queue = new CommandQueue(deps.clock);
    this.warnInvalidWire = createThrottledWarn(deps.logger, deps.clock);
    // Built here, not as a field initializer, so it never depends on field-initialization order.
    this.channelHost = {
      transport: deps.transport,
      canPublish: () => this.transport.isHost() && !this.recovery,
      sendCommand: (ch, type, payload) => this.sendCommand(ch, type, payload),
      broadcast: (wire) => this.transport.broadcast(wire),
      sendTo: (to, wire) => this.transport.send(to, wire),
      statusMayHaveChanged: () => this.refreshStatus(),
    };
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
    this.cancelResync?.();
    this.cancelResync = undefined;
    this.statusChanged.clear();
  }

  getStatus(): BusStatus {
    return this.status;
  }

  inspect(): Record<string, unknown> {
    return {
      status: this.status,
      started: this.started,
      localPeerId: this.transport.getLocalPeerId(),
      hostPeerId: this.transport.getHostPeerId(),
      isHost: this.transport.isHost(),
      seq: this.seq,
      resyncing: this.cancelResync !== undefined,
      recovery: this.recovery?.inspect() ?? null,
      queue: this.queue.pending().map((c) => ({
        id: c.id,
        seq: c.seq,
        ch: c.ch,
        type: c.type,
        sentTo: c.sentTo,
      })),
      channels: Object.fromEntries(
        Array.from(this.stateChannels, ([id, channel]) => [id, channel.inspect()])
      ),
      eventChannels: Array.from(this.eventChannels.keys()),
    };
  }

  onStatusChanged(handler: (status: BusStatus) => void): () => void {
    return this.statusChanged.on(handler);
  }

  // ─── Internals exposed to channels ────────────────────────────────────────

  private sendCommand(ch: string, type: string, payload: unknown): Promise<CommandResult> {
    const cmd: QueuedCommand = { id: this.deps.ids.next(), seq: ++this.seq, ch, type, payload };
    const result = this.queue.enqueue(cmd, this.options.commandTtlMs);
    this.flushQueue();
    return result;
  }

  // ─── Incoming ─────────────────────────────────────────────────────────────

  private readonly wireHandlers: WireHandlers = {
    state: (w, from) => {
      if (from !== this.transport.getHostPeerId() || this.transport.isHost()) return;
      this.stateChannels.get(w.ch)?.acceptState(w);
      this.refreshStatus();
    },
    ack: (w, from) => {
      if (from !== this.transport.getHostPeerId()) return;
      if (!w.result.ok) {
        this.deps.logger.info(`Command ${w.id} rejected by host: ${w.result.reason}`);
      }
      this.queue.ack(w.id, w.result);
    },
    event: (w, from) => {
      this.eventChannels.get(w.ch)?.receive(w.event, from);
    },
    offer: (w, from) => {
      if (this.transport.isHost() && this.recovery) this.recovery.recordOffer(from, w.channels);
    },
    sync: (w, from) => {
      if (this.transport.isHost() && !this.recovery) {
        this.stateChannels.get(w.ch)?.sendSnapshot(from);
      }
    },
    command: (w, from) => {
      if (!this.transport.isHost()) return; // stale routing; the sender re-sends after it learns the host
      if (this.recovery) this.recovery.hold(w, from);
      else this.processRemoteCommand(w, from);
    },
    recover: (_w, from) => {
      // The new host asks for our copies. (The mirror image of guests offering on link-up:
      // between the two, an offer that arrives before the host knows it is host is never lost.)
      if (!this.transport.isHost() && from === this.transport.getHostPeerId()) {
        this.syncWithHost();
      }
    },
  };

  private handleWire(payload: unknown, from: PeerId): void {
    if (from === this.transport.getLocalPeerId()) return; // own broadcast echoed back
    const w = parseWire(payload);
    if (!w) {
      this.warnInvalidWire(`wire:${from}`, "Dropped invalid wire message", {
        from,
        kind: isRecord(payload) ? payload.kind : typeof payload,
      });
      return;
    }
    (this.wireHandlers[w.kind] as (w: Wire, from: PeerId) => void)(w, from);
  }

  private processRemoteCommand(w: Extract<Wire, { kind: "command" }>, from: PeerId): void {
    const result = this.execute(from, w.ch, w.seq, w.type, w.payload);
    if (!result.ok)
      this.deps.logger.info(`Command rejected: ${result.reason}`, {
        from,
        ch: w.ch,
        type: w.type,
      });
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
    const hostId = this.transport.getHostPeerId();
    const promoted = iAmHost && !this.wasHost;
    const demoted = !iAmHost && this.wasHost;
    // The host document fires again for the same host (e.g. a repeated election write).
    // That must not discard state we already synced.
    const hostMoved = hostId !== this.lastHostId;
    this.wasHost = iAmHost;
    this.lastHostId = hostId;

    if (promoted) this.deps.logger.debug("Promoted to host", { host: hostId });
    if (demoted) this.deps.logger.debug("Demoted to guest", { host: hostId });

    if (demoted) this.endRecovery();
    if (promoted) this.beginRecovery();
    if (!iAmHost) {
      if (hostMoved || demoted) {
        for (const channel of this.stateChannels.values()) channel.markUnsynced();
        this.queue.resetRouting();
      }
      this.syncWithHost();
    }
    this.flushQueue();
    this.refreshStatus();
  }

  private handleLinkActive(peerId: PeerId): void {
    if (this.transport.isHost()) {
      if (this.recovery) this.recovery.noteActivity();
      else for (const channel of this.stateChannels.values()) channel.sendSnapshot(peerId);
    } else if (peerId === this.transport.getHostPeerId()) {
      this.syncWithHost();
    }
    this.refreshStatus();
  }

  /** Guest, link to host is up: offer our copies (matters after a promotion), ask for what we lack, flush commands. */
  private syncWithHost(): void {
    const hostId = this.transport.getHostPeerId();
    if (!hostId || this.transport.isHost() || !this.transport.isLinkActive(hostId)) return;
    const channels = Array.from(this.stateChannels.values(), (c) => c.copy());
    this.transport.send(hostId, { __bus: 1, kind: "offer", channels });
    this.requestMissingSnapshots(hostId);
    this.flushQueue();
  }

  // The host replies once it has finished recovery, so this is safe to repeat.
  private requestMissingSnapshots(hostId: PeerId): void {
    for (const channel of this.stateChannels.values()) {
      if (!channel.isSynced())
        this.transport.send(hostId, { __bus: 1, kind: "sync", ch: channel.id });
    }
  }

  private updateResync(): void {
    const hostId = this.transport.getHostPeerId();
    const needed =
      this.started &&
      !this.transport.isHost() &&
      !!hostId &&
      this.transport.isLinkActive(hostId) &&
      Array.from(this.stateChannels.values()).some((c) => !c.isSynced());

    if (needed && !this.cancelResync) {
      this.cancelResync = this.deps.clock.every(this.options.resyncIntervalMs, () => {
        const current = this.transport.getHostPeerId();
        if (current && !this.transport.isHost() && this.transport.isLinkActive(current)) {
          this.requestMissingSnapshots(current);
        }
      });
    } else if (!needed && this.cancelResync) {
      this.cancelResync();
      this.cancelResync = undefined;
    }
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
  // publishes anything, it asks (and guests offer when their link comes up) for
  // every guest's copy and adopts the newest. The collecting is in BusRecovery.

  private beginRecovery(): void {
    this.endRecovery();
    this.cancelResync?.();
    this.cancelResync = undefined;
    const recovery = new BusRecovery({
      clock: this.deps.clock,
      windowMs: this.options.recoveryWindowMs,
      maxMs: this.options.recoveryMaxMs,
      getExpectedPeerIds: () => this.transport.getExpectedPeerIds(),
      onFinish: (result) => this.finishRecovery(result),
    });
    this.recovery = recovery;
    this.transport.broadcast({ __bus: 1, kind: "recover" });
    recovery.checkComplete(); // may finish right here when nobody else is expected
  }

  private finishRecovery(result: RecoveryResult): void {
    this.recovery = undefined; // before publishing, so canPublish() is true

    this.deps.logger.debug("Recovery finished", {
      offers: result.offers,
      adopted: Array.from(result.best.keys()),
      held: result.held.length,
    });

    for (const channel of this.stateChannels.values()) {
      const offered: ChannelCopy | undefined = result.best.get(channel.id);
      if (offered) channel.adoptIfNewer(offered);
      channel.promote();
    }
    for (const { w, from } of result.held) this.processRemoteCommand(w, from);
    this.flushQueue();
    this.refreshStatus();
  }

  private endRecovery(): void {
    this.recovery?.cancel();
    this.recovery = undefined;
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  private computeStatus(): BusStatus {
    const hostId = this.transport.getHostPeerId();
    return computeBusStatus({
      started: this.started,
      isHost: this.transport.isHost(),
      recovering: this.recovery !== undefined,
      hostLinkActive: hostId !== undefined && this.transport.isLinkActive(hostId),
      allChannelsSynced: Array.from(this.stateChannels.values()).every((c) => c.isSynced()),
    });
  }

  private refreshStatus(): void {
    this.updateResync();
    const next = this.computeStatus();
    if (next === this.status) return;
    this.status = next;
    this.deps.logger.debug(`Status → ${next}`, {
      host: this.transport.getHostPeerId(),
      isHost: this.transport.isHost(),
      recovering: this.recovery !== undefined,
    });
    this.statusChanged.emit(next);
  }
}
