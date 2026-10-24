import {
  Cell,
  Emitter,
  Scope,
  createThrottledWarn,
  listenerFailure,
  type Clock,
  type Listenable,
  type Logger,
  type PeerId,
  type PlayerId,
  type Store,
  type ThrottledWarn,
} from "@/kernel";
import type { DropReason, LinkState, Member, Wire } from "../model";
import { createEnvelopeParser, encodeEnvelope, type Envelope } from "./envelope";
import {
  activeTargets,
  bindHello,
  fitsLimit,
  pruneBindings,
  sameBindings,
  shouldAnnounce,
} from "./rules";

/** The part of ChunkedMessenger the relay needs. */
export interface RelayMessenger {
  sendToPeer(peerId: PeerId, message: string): void;
  onMessage(handler: (message: string, from: PeerId) => void): () => void;
}

export interface RelayDeps {
  messenger: RelayMessenger;
  self: PeerId;
  /** Sent in `hello`: the one durable identity transport carries. */
  playerId: PlayerId;
  role: Store<"guest" | "host">;
  host: Store<PeerId | undefined>;
  links: Store<ReadonlyMap<PeerId, LinkState>>;
  members: Store<ReadonlyMap<PeerId, Member>>;
  clock: Clock;
  logger: Logger;
  /** Largest encoded envelope this peer will send or accept. */
  maxMessageChars: number;
}

// Star relay. The host stamps the verified sender on everything it forwards; a guest trusts only
// what the host sends. Hello binds a link's peer to a playerId on the host (final per peer).
export class Relay {
  private readonly parse: (raw: string) => ReturnType<ReturnType<typeof createEnvelopeParser>>;
  private readonly warn: ThrottledWarn;
  private readonly onListenerError = listenerFailure(() => this.deps.logger);
  private readonly received = new Emitter<{ from: PeerId; msg: Wire }>(this.onListenerError);
  private readonly byes = new Emitter<DropReason>(this.onListenerError);
  private readonly bindingsCell = new Cell<ReadonlyMap<PeerId, PlayerId>>(new Map(), {
    equals: sameBindings,
    onError: this.onListenerError,
  });

  private announcedHost?: PeerId;
  private wasActive = false;

  constructor(
    private readonly deps: RelayDeps,
    scope: Scope
  ) {
    this.parse = createEnvelopeParser({ maxMessageChars: deps.maxMessageChars });
    this.warn = createThrottledWarn(deps.logger, deps.clock);

    scope.add(deps.messenger.onMessage((raw, from) => this.handleRaw(raw, from)));
    scope.add(
      deps.members.subscribe((members) =>
        this.bindingsCell.set(pruneBindings(this.bindingsCell.get(), (id) => members.has(id)))
      )
    );
    const announce = () => this.announceIfNeeded();
    scope.add(deps.role.subscribe(announce));
    scope.add(deps.host.subscribe(announce));
    scope.add(deps.links.subscribe(announce));
    announce();
  }

  /** Host side: playerId per peer, learned from verified hellos. */
  get bindings(): Store<ReadonlyMap<PeerId, PlayerId>> {
    return this.bindingsCell;
  }

  /** `from` is host-verified. Never contains this peer's own messages. */
  get messages(): Listenable<{ from: PeerId; msg: Wire }> {
    return this.received;
  }

  /** Guest side: the host said it dropped us. */
  get byeReceived(): Listenable<DropReason> {
    return this.byes;
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  send(to: PeerId, msg: Wire): void {
    const { self, role, host } = this.deps;
    if (to === self) return;
    const envelope: Envelope = { kind: "app", scope: "direct", from: self, to, msg };
    const target = role.get() === "host" ? to : host.get();
    if (target !== undefined) this.dispatch(target, envelope);
  }

  broadcast(msg: Wire): void {
    const { self, role, host, links } = this.deps;
    const envelope: Envelope = { kind: "app", scope: "broadcast", from: self, msg };
    if (role.get() !== "host") {
      const hostId = host.get();
      if (hostId !== undefined) this.dispatch(hostId, envelope);
      return;
    }
    for (const peerId of activeTargets(links.get(), [self])) this.dispatch(peerId, envelope);
  }

  /** Host only. The caller (drop) decides when the link may close. */
  sendBye(peer: PeerId, reason: DropReason): void {
    if (this.deps.role.get() !== "host") return;
    this.dispatch(peer, { kind: "bye", reason });
  }

  // ─── Receiving ────────────────────────────────────────────────────────────

  private handleRaw(raw: string, from: PeerId): void {
    const envelope = this.parse(raw);
    if (!envelope) {
      this.warn(`envelope:${from}`, "Dropped invalid envelope", { from, kind: "envelope" });
      return;
    }
    if (this.deps.role.get() === "host") this.asHost(envelope, from);
    else this.asGuest(envelope, from);
  }

  private asHost(envelope: Envelope, from: PeerId): void {
    const { self, links } = this.deps;
    switch (envelope.kind) {
      case "hello": {
        const { outcome, next } = bindHello(this.bindingsCell.get(), from, envelope.playerId);
        if (outcome === "conflict") {
          this.warn(`rebind:${from}`, "Ignored hello that rebinds a peer", { from, kind: "hello" });
        }
        this.bindingsCell.set(next);
        return;
      }
      case "bye":
        return; // only the host sends these
      case "app": {
        // Claims inside the envelope are data: the sender is whoever the link says it is.
        const stamped: Envelope = { ...envelope, from };
        if (envelope.scope === "broadcast") {
          this.received.emit({ from, msg: envelope.msg });
          for (const peerId of activeTargets(links.get(), [self, from])) {
            this.dispatch(peerId, stamped);
          }
        } else if (envelope.to === self) {
          this.received.emit({ from, msg: envelope.msg });
        } else {
          this.dispatch(envelope.to, stamped);
        }
        return;
      }
    }
  }

  private asGuest(envelope: Envelope, from: PeerId): void {
    if (from !== this.deps.host.get()) {
      this.warn(`not-host:${from}`, "Dropped envelope from a non-host peer", {
        from,
        kind: envelope.kind,
      });
      return;
    }
    switch (envelope.kind) {
      case "bye":
        this.byes.emit(envelope.reason);
        return;
      case "hello":
        return; // only guests send these
      case "app":
        if (envelope.from === this.deps.self) return;
        if (envelope.scope === "direct" && envelope.to !== this.deps.self) return;
        this.received.emit({ from: envelope.from, msg: envelope.msg });
        return;
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Encodes, applies the sender-side size guard, and sends only over an active link. */
  private dispatch(target: PeerId, envelope: Envelope): void {
    const { messenger, links, logger, maxMessageChars } = this.deps;
    const encoded = encodeEnvelope(envelope);
    if (!fitsLimit(encoded, maxMessageChars)) {
      logger.warn("Refused to send an oversize message", {
        chars: encoded.length,
        max: maxMessageChars,
        kind: envelope.kind,
      });
      return;
    }
    if (links.get().get(target) !== "active") return; // silently dropped, callers repeat what must arrive
    messenger.sendToPeer(target, encoded);
  }

  // Hello repeats when the link to the host becomes active and when the host changes, so a new
  // host rebuilds every binding from the guests.
  private announceIfNeeded(): void {
    const { role, host, links, playerId } = this.deps;
    const hostId = host.get();
    const { announce, active } = shouldAnnounce({
      role: role.get(),
      host: hostId,
      hostLink: hostId === undefined ? undefined : links.get().get(hostId),
      announcedHost: this.announcedHost,
      wasActive: this.wasActive,
    });
    this.wasActive = active;
    if (!announce || hostId === undefined) return;
    this.announcedHost = hostId;
    this.dispatch(hostId, { kind: "hello", playerId });
  }
}
