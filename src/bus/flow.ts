// The bus's moving parts: wire handlers, host and link watchers, promotion recovery, resync and
// the command queue. Decisions live in rules.ts; this class only connects them to the transport.

import {
  Cell,
  createThrottledWarn,
  derived,
  fail,
  structurallyEqual,
  type Cancel,
  type ChannelId,
  type PeerId,
  type PlayerId,
  type Result,
  type Scope,
  type Store,
  type ThrottledWarn,
} from "@/kernel";
import type { Transport } from "@/transport";
import type { BusEventChannel } from "./channels/event";
import type { ChannelHost } from "./channels/host";
import type { BusPrivateChannel } from "./channels/private";
import type { BusStateChannel } from "./channels/state";
import type { BusDeps, BusSync } from "./model";
import { MAX_REASON_CHARS } from "./names";
import { CommandQueue } from "./queue";
import { BusRecovery, type RecoveryResult } from "./recovery";
import { computeSync, continuedOffset, needsResync, pickPeer, type SyncInput } from "./rules";
import {
  ackVerdict,
  claimedKind,
  createBusWire,
  type BusMsg,
  type BusMsgOf,
  type BusWire,
  type WireHandlers,
} from "./wire";

export class BusFlow {
  readonly sync: Store<BusSync>;
  readonly host: ChannelHost;

  private readonly transport: Transport;
  private readonly wire: BusWire;
  private readonly queue: CommandQueue;
  private readonly warnInvalidWire: ThrottledWarn;
  private readonly states = new Map<ChannelId, BusStateChannel>();
  private readonly events = new Map<ChannelId, BusEventChannel>();
  private readonly privs = new Map<ChannelId, BusPrivateChannel>();

  private readonly startedCell = new Cell(false);
  private readonly recoveringCell = new Cell(false);
  private readonly allSyncedCell = new Cell(true);
  private readonly resyncNeeded: Store<boolean>;

  private recovery?: BusRecovery;
  private cancelResync?: Cancel;
  private prevLinks: ReadonlyMap<PeerId, string> = new Map();
  private wasHost = false;
  private seq = 0;
  /** Added to the local clock to get continuous host time. */
  private offset = 0;

  constructor(
    private readonly deps: BusDeps,
    private readonly scope: Scope
  ) {
    const { clock, config, log } = deps;
    this.transport = deps.transport;
    const { role, host, links } = this.transport;
    this.wire = createBusWire({ maxValueChars: config.maxStateChars });
    this.queue = new CommandQueue({ clock });
    this.warnInvalidWire = createThrottledWarn(log, clock);

    const input = derived(
      [role, host, links, this.startedCell, this.recoveringCell, this.allSyncedCell] as const,
      (r, h, l, started, recovering, allChannelsSynced): SyncInput => ({
        started,
        isHost: r === "host",
        recovering,
        hostLinkActive: h !== undefined && l.get(h) === "active",
        allChannelsSynced,
      }),
      structurallyEqual
    );
    this.sync = derived([input] as const, computeSync);
    this.resyncNeeded = derived([input] as const, needsResync);

    this.host = {
      self: this.transport.self,
      localPlayerId: deps.localPlayerId,
      role,
      isHost: () => role.get() === "host",
      canCommit: () => role.get() === "host" && !this.recovery,
      now: () => this.now(),
      observeHostTime: (asOf) => {
        // Never lets host time run backwards because of network jitter.
        this.offset = Math.max(this.offset, asOf - clock.now());
      },
      broadcast: (msg) => this.transport.broadcast(this.wire.encode(msg)),
      sendTo: (to, msg) => this.transport.send(to, this.wire.encode(msg)),
      sendCommand: (ch, type, payload) => {
        const id = deps.ids.next();
        const verdict = this.queue.enqueue(
          { id, seq: ++this.seq, ch: ch as ChannelId, type, payload },
          config.commandTtlMs
        );
        this.flushQueue();
        return verdict;
      },
      playerOf: (peer) => this.transport.members.get().get(peer)?.playerId,
      peerOf: (player) => this.peerOf(player),
      linkActive: (peer) => this.transport.links.get().get(peer) === "active",
    };

    scope.add(() => this.dispose());
  }

  now(): number {
    return this.deps.clock.now() + this.offset;
  }

  // ─── Registration (before start) ──────────────────────────────────────────

  addState(channel: BusStateChannel): void {
    this.register(this.states, channel);
  }

  addEvents(channel: BusEventChannel): void {
    this.register(this.events, channel);
  }

  /** `of` is the state handle `bus.state()` returned; its commits feed this private channel. */
  addPrivate(channel: BusPrivateChannel, of: unknown): void {
    const owner = Array.from(this.states.values()).find((c) => (c as unknown) === of);
    if (!owner) throw new Error(`[bus] "${channel.id}": "of" must be a state handle of this bus.`);
    this.register(this.privs, channel);
    owner.attachPrivate(channel);
  }

  private register<C extends { id: ChannelId }>(registry: Map<ChannelId, C>, channel: C): void {
    if (this.startedCell.get()) {
      throw new Error(`[bus] "${channel.id}" registered after start().`);
    }
    if (this.states.has(channel.id) || this.events.has(channel.id) || this.privs.has(channel.id)) {
      throw new Error(`[bus] Duplicate channel "${channel.id}".`);
    }
    registry.set(channel.id, channel);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.startedCell.get()) return;
    const { role, host, links, members, messages } = this.transport;
    this.startedCell.set(true);
    this.prevLinks = links.get();
    this.wasHost = false;

    this.scope.on(messages, ({ from, msg }) => this.handleWire(from, msg));
    this.scope.watch(links, (next) => this.handleLinks(next));
    this.scope.watch(members, (next) => this.pruneApplied(next));
    this.scope.watch(this.resyncNeeded, (needed) => this.setResync(needed));
    const route = derived([role, host] as const, (r, h) => ({ role: r, host: h }));
    this.scope.watch(route, (next) => this.handleRoute(next.role === "host", next.host));

    const synced = [...this.states.values(), ...this.privs.values()];
    for (const channel of synced) this.scope.watch(channel.synced, () => this.recomputeSynced());
    this.recomputeSynced();
    this.setResync(this.resyncNeeded.get());
    this.handleRoute(role.get() === "host", host.get());
  }

  private dispose(): void {
    this.startedCell.set(false);
    this.endRecovery();
    this.queue.rejectAll();
    this.setResync(false);
  }

  private recomputeSynced(): void {
    const all =
      Array.from(this.states.values()).every((c) => c.isSynced()) &&
      Array.from(this.privs.values()).every((c) => c.isSynced());
    this.allSyncedCell.set(all);
  }

  // ─── Incoming ─────────────────────────────────────────────────────────────

  private readonly handlers: WireHandlers = {
    state: (from, msg) => {
      if (this.isHost() || from !== this.hostId()) return;
      this.states.get(msg.ch)?.acceptState(msg);
    },
    ack: (from, msg) => {
      if (from !== this.hostId()) return;
      const verdict = ackVerdict(msg);
      if (!verdict.ok) this.deps.log.info(`Command ${msg.id} rejected by host: ${verdict.reason}`);
      this.queue.ack(msg.id, verdict);
    },
    event: (from, msg) => {
      this.events.get(msg.ch)?.receive(from, msg.event);
    },
    offer: (from, msg) => {
      if (this.isHost()) this.recovery?.recordOffer(from, msg.channels);
    },
    sync: (from, msg) => {
      if (this.isHost() && !this.recovery) this.states.get(msg.ch)?.sendSnapshot(from);
    },
    command: (from, msg) => {
      if (!this.isHost()) return; // stale routing; the sender re-sends after it learns the host
      if (this.recovery) this.recovery.hold(msg, from);
      else this.processRemoteCommand(msg, from);
    },
    recover: (from) => {
      // The new host asks for our copies (the mirror image of guests offering on link-up).
      if (!this.isHost() && from === this.hostId()) this.syncWithHost();
    },
    private: (from, msg) => {
      if (this.isHost() || from !== this.hostId()) return;
      this.privs.get(msg.ch)?.receivePiece(msg);
    },
    mine: (from, msg) => {
      if (this.isHost()) this.privs.get(msg.ch)?.receiveOffer(from, msg);
    },
  };

  private handleWire(from: PeerId, raw: unknown): void {
    if (!this.startedCell.get()) return;
    const parsed = this.wire.parse(raw);
    if (!parsed.ok) {
      this.warnInvalidWire(`wire:${from}`, "Dropped invalid wire message", {
        from,
        kind: claimedKind(raw),
        path: parsed.reason.path,
      });
      return;
    }
    const msg = parsed.value;
    (this.handlers[msg.kind] as (from: PeerId, msg: BusMsg) => void)(from, msg);
  }

  private processRemoteCommand(msg: BusMsgOf<"command">, from: PeerId): void {
    const verdict = this.execute(from, msg);
    if (!verdict.ok) {
      this.deps.log.info(`Command rejected: ${verdict.reason}`, {
        from,
        ch: msg.ch,
        type: msg.type,
      });
    }
    const ack: BusMsgOf<"ack"> = verdict.ok
      ? { kind: "ack", id: msg.id, ok: true }
      : { kind: "ack", id: msg.id, ok: false, reason: verdict.reason.slice(0, MAX_REASON_CHARS) };
    this.host.sendTo(from, ack);
  }

  private execute(from: PeerId, msg: BusMsgOf<"command">): Result<void, string> {
    const channel = this.states.get(msg.ch);
    return channel ? channel.execute(from, msg) : fail("unknown-channel");
  }

  // ─── Routing: who is host, is the link up ─────────────────────────────────

  private isHost(): boolean {
    return this.transport.role.get() === "host";
  }

  private hostId(): PeerId | undefined {
    return this.transport.host.get();
  }

  private hostLinkActive(): PeerId | undefined {
    const hostId = this.hostId();
    return hostId !== undefined && this.transport.links.get().get(hostId) === "active"
      ? hostId
      : undefined;
  }

  /** Called once per real change of role or host (and once at start). */
  private handleRoute(iAmHost: boolean, hostId: PeerId | undefined): void {
    const promoted = iAmHost && !this.wasHost;
    const demoted = !iAmHost && this.wasHost;
    this.wasHost = iAmHost;
    this.deps.log.debug(promoted ? "Promoted to host" : demoted ? "Demoted to guest" : "Host", {
      host: hostId,
    });

    if (demoted) {
      this.endRecovery();
      for (const channel of this.privs.values()) channel.pruneToOwn();
    }
    if (promoted) this.beginRecovery();
    if (!iAmHost) {
      for (const channel of this.states.values()) channel.markUnsynced();
      this.queue.resetRouting();
      this.syncWithHost();
    }
    this.flushQueue();
  }

  private handleLinks(links: ReadonlyMap<PeerId, string>): void {
    const prev = this.prevLinks;
    this.prevLinks = links;
    for (const [peer, state] of links) {
      if (state === "active" && prev.get(peer) !== "active") this.handleLinkActive(peer);
    }
  }

  private handleLinkActive(peer: PeerId): void {
    if (this.isHost()) {
      if (this.recovery) {
        this.recovery.noteActivity();
        return;
      }
      for (const channel of this.states.values()) channel.sendSnapshot(peer);
      for (const channel of this.privs.values()) channel.onLinkActive(peer);
    } else if (peer === this.hostId()) {
      this.syncWithHost();
    }
  }

  /** Guest, link to host is up: offer our copies (matters after a promotion), ask for what we lack, flush commands. */
  private syncWithHost(): void {
    const hostId = this.hostLinkActive();
    if (hostId === undefined || this.isHost()) return;
    // Our pieces go first: the host's recovery finishes on the state offers, and must already
    // have every piece by then (the link is ordered).
    for (const channel of this.privs.values()) channel.offerTo(hostId);
    const channels = Array.from(this.states.values(), (c) => c.copy());
    this.host.sendTo(hostId, { kind: "offer", channels });
    this.requestMissingSnapshots(hostId);
    this.flushQueue();
  }

  // The host replies once it has finished recovery, so this is safe to repeat.
  private requestMissingSnapshots(hostId: PeerId): void {
    for (const channel of this.states.values()) {
      if (!channel.isSynced()) this.host.sendTo(hostId, { kind: "sync", ch: channel.id });
    }
    for (const channel of this.privs.values()) {
      if (!channel.isSynced()) channel.offerTo(hostId); // also asks the host to send it again
    }
  }

  private setResync(needed: boolean): void {
    if (needed && !this.cancelResync) {
      this.cancelResync = this.deps.clock.every(this.deps.config.resyncIntervalMs, () => {
        const hostId = this.hostLinkActive();
        if (hostId !== undefined && !this.isHost()) this.requestMissingSnapshots(hostId);
      });
    } else if (!needed && this.cancelResync) {
      this.cancelResync();
      this.cancelResync = undefined;
    }
  }

  private flushQueue(): void {
    const hostId = this.hostId();
    if (hostId === undefined || !this.startedCell.get()) return;
    const iAmHost = this.isHost();
    if (iAmHost ? this.recovery : this.hostLinkActive() === undefined) return;

    for (const cmd of this.queue.pending()) {
      if (cmd.sentTo === hostId) continue;
      this.queue.markSent(cmd.id, hostId);
      const msg: BusMsgOf<"command"> = {
        kind: "command",
        ch: cmd.ch,
        id: cmd.id,
        seq: cmd.seq,
        type: cmd.type,
        payload: cmd.payload as BusMsgOf<"command">["payload"],
      };
      if (iAmHost) this.queue.ack(cmd.id, this.execute(this.host.self, msg));
      else this.host.sendTo(hostId, msg);
    }
  }

  private peerOf(player: PlayerId): PeerId | undefined {
    const links = this.transport.links.get();
    const candidates = [];
    for (const member of this.transport.members.get().values()) {
      if (member.playerId !== player || member.peerId === this.host.self) continue;
      candidates.push({
        peerId: member.peerId,
        joinedAt: member.joinedAt,
        active: links.get(member.peerId) === "active",
      });
    }
    return pickPeer(candidates);
  }

  private pruneApplied(members: ReadonlyMap<PeerId, unknown>): void {
    if (!this.isHost()) return;
    const keep = new Set<string>(members.keys());
    keep.add(this.host.self);
    for (const channel of this.states.values()) channel.pruneApplied(keep);
  }

  // ─── Promotion recovery ───────────────────────────────────────────────────
  // A new host may be a freshly refreshed tab with empty state. Before it publishes anything it
  // asks (and guests offer when their link comes up) for every guest's copy and adopts the newest.
  // The collecting is in BusRecovery.

  private beginRecovery(): void {
    this.endRecovery();
    this.recovery = new BusRecovery({
      clock: this.deps.clock,
      config: this.deps.config,
      linkedPeerIds: () => this.activePeers(),
      expectedPeerIds: () => Array.from(this.transport.links.get().keys()),
      onFinish: (result) => this.finishRecovery(result),
    });
    this.recoveringCell.set(true);
    this.transport.broadcast(this.wire.encode({ kind: "recover" }));
    this.recovery.checkComplete(); // may finish right here when nobody else is expected
  }

  private activePeers(): PeerId[] {
    const active: PeerId[] = [];
    for (const [peer, state] of this.transport.links.get())
      if (state === "active") active.push(peer);
    return active;
  }

  private finishRecovery(result: RecoveryResult): void {
    this.recovery = undefined; // before publishing, so canCommit() is true
    this.recoveringCell.set(false);
    this.deps.log.debug("Recovery finished", {
      offers: result.offers,
      adopted: Array.from(result.best.keys()),
      held: result.held.length,
    });

    const offset = continuedOffset(result.best.values(), this.deps.clock.now());
    if (offset !== undefined) this.offset = offset; // host time carries on from the old host

    this.pruneApplied(this.transport.members.get());
    for (const channel of this.states.values()) {
      const offered = result.best.get(channel.id);
      if (offered) channel.adoptIfNewer(offered);
      channel.promote();
    }
    for (const channel of this.privs.values()) channel.acceptOffers();
    for (const { msg, from } of result.held) this.processRemoteCommand(msg, from);
    this.flushQueue();
  }

  private endRecovery(): void {
    this.recovery?.cancel();
    this.recovery = undefined;
    this.recoveringCell.set(false);
  }
}
