// In-memory Transport network for bus tests. Star topology like the real one: the host has a link
// to every guest, a guest only to the host. `send` is dropped unless the needed links are active,
// a guest-to-guest message is relayed by the host, `from` is the true sender, nothing is echoed.
// Delivery is queued, in order; by default it flushes in a microtask, or call flush() yourself.

import {
  Cell,
  Emitter,
  as,
  batch,
  fail,
  ok,
  type Listenable,
  type PeerId,
  type PlayerId,
  type Result,
  type Store,
} from "@/kernel";
import type { DropReason, HandOffReject, LinkState, Member, Transport, Wire } from "@/transport";

const pairKey = (a: PeerId, b: PeerId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

function sameMap<V>(
  a: ReadonlyMap<PeerId, V>,
  b: ReadonlyMap<PeerId, V>,
  eq: (x: V, y: V) => boolean
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || !eq(value, other)) return false;
  }
  return true;
}

interface TransportView {
  role: "guest" | "host";
  host: PeerId | undefined;
  members: ReadonlyMap<PeerId, Member>;
  links: ReadonlyMap<PeerId, LinkState>;
}

type Incoming = { from: PeerId; msg: Wire };

export class FakeTransport implements Transport {
  private readonly roleCell = new Cell<"guest" | "host">("guest");
  private readonly hostCell = new Cell<PeerId | undefined>(undefined);
  private readonly membersCell = new Cell<ReadonlyMap<PeerId, Member>>(new Map(), {
    equals: (a, b) =>
      sameMap(
        a,
        b,
        (x, y) => x.joinedAt === y.joinedAt && x.playerId === y.playerId && x.peerId === y.peerId
      ),
  });
  private readonly linksCell = new Cell<ReadonlyMap<PeerId, LinkState>>(new Map(), {
    equals: (a, b) => sameMap(a, b, (x, y) => x === y),
  });
  private readonly messageEm = new Emitter<Incoming>();
  private readonly droppedEm = new Emitter<DropReason>();

  readonly role: Store<"guest" | "host"> = this.roleCell;
  readonly host: Store<PeerId | undefined> = this.hostCell;
  readonly members: Store<ReadonlyMap<PeerId, Member>> = this.membersCell;
  readonly links: Store<ReadonlyMap<PeerId, LinkState>> = this.linksCell;
  readonly messages: Listenable<Incoming> = this.messageEm;
  readonly dropped: Listenable<DropReason> = this.droppedEm;

  constructor(
    readonly self: PeerId,
    private readonly network: FakeBusNetwork
  ) {}

  send(to: PeerId, msg: Wire): void {
    this.network.send(this.self, to, msg);
  }

  broadcast(msg: Wire): void {
    this.network.broadcast(this.self, msg);
  }

  drop(peer: PeerId, reason: DropReason): Promise<void> {
    this.network.drop(peer, reason);
    return Promise.resolve();
  }

  handOff(to: PeerId): Promise<Result<void, HandOffReject>> {
    return Promise.resolve(this.network.handOff(this.self, to));
  }

  leave(): Promise<void> {
    this.network.kill(this.self);
    this.network.removeMember(this.self);
    return Promise.resolve();
  }

  /** @internal called by the network. */
  update(view: TransportView): void {
    this.roleCell.set(view.role);
    this.hostCell.set(view.host);
    this.membersCell.set(view.members);
    this.linksCell.set(view.links);
  }

  /** @internal called by the network. */
  receive(incoming: Incoming): void {
    this.messageEm.emit(incoming);
  }

  /** @internal called by the network. */
  notifyDropped(reason: DropReason): void {
    this.droppedEm.emit(reason);
  }
}

export class FakeBusNetwork {
  private readonly transports = new Map<PeerId, FakeTransport>();
  private readonly players = new Map<PeerId, PlayerId>();
  private readonly joinedAt = new Map<PeerId, number>();
  private readonly pairs = new Map<string, LinkState>();
  private readonly dead = new Set<PeerId>();
  private readonly members = new Set<PeerId>();
  private hostId: PeerId | undefined;
  private queue: Array<{ to: PeerId; incoming: Incoming }> = [];
  private scheduled = false;
  private order = 0;

  /** Every message that was accepted for delivery, for assertions. */
  readonly sent: Array<{ from: PeerId; to: PeerId; msg: Wire }> = [];

  constructor(private readonly options: { autoFlush?: boolean } = {}) {}

  /** A new member. The first peer becomes host; later peers link to the host as `active`. */
  addPeer(name: string, playerId: string = name): FakeTransport {
    const peerId = as<PeerId>(name);
    const transport = new FakeTransport(peerId, this);
    this.transports.set(peerId, transport);
    this.players.set(peerId, as<PlayerId>(playerId));
    this.joinedAt.set(peerId, ++this.order);
    this.members.add(peerId);
    if (this.hostId === undefined) this.hostId = peerId;
    else this.setLink(peerId, this.hostId, "active");
    this.refresh();
    return transport;
  }

  /** Makes `name` host. Links it to every live peer it has none to yet (as `active`). Never closes links. */
  setHost(name: string): void {
    const next = as<PeerId>(name);
    this.hostId = next;
    for (const peer of this.transports.keys()) {
      if (peer !== next && !this.dead.has(peer) && !this.pairs.has(pairKey(peer, next))) {
        this.pairs.set(pairKey(peer, next), "active");
      }
    }
    this.refresh();
  }

  /** Sets (or creates) the link between two peers. */
  link(a: string, b: string, state: LinkState = "active"): void {
    this.setLink(as<PeerId>(a), as<PeerId>(b), state);
    this.refresh();
  }

  /** Removes the link between two peers (they simply have none). */
  cut(a: string, b: string): void {
    this.pairs.delete(pairKey(as<PeerId>(a), as<PeerId>(b)));
    this.refresh();
  }

  /** Abrupt death: its links vanish and it receives nothing. Membership and host are untouched. */
  kill(name: string): void {
    const peer = as<PeerId>(name);
    this.dead.add(peer);
    for (const key of Array.from(this.pairs.keys())) {
      if (key.split("|").includes(peer)) this.pairs.delete(key);
    }
    this.queue = this.queue.filter((item) => item.to !== peer);
    this.refresh();
  }

  /** Membership removal (what an election or the host does), without touching links. */
  removeMember(name: string): void {
    this.members.delete(as<PeerId>(name));
    this.refresh();
  }

  /** Delivers every queued message, in order, including ones queued by handlers. */
  flush(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || this.dead.has(next.to)) continue;
      this.transports.get(next.to)?.receive(next.incoming);
    }
  }

  // ─── Called by FakeTransport ──────────────────────────────────────────────

  /** @internal */
  send(from: PeerId, to: PeerId, msg: Wire): void {
    if (from === to || this.dead.has(from) || this.dead.has(to)) return;
    if (!this.canReach(from, to)) return;
    this.enqueue(from, to, msg);
  }

  /** @internal */
  broadcast(from: PeerId, msg: Wire): void {
    if (this.dead.has(from)) return;
    for (const to of this.transports.keys()) {
      if (to === from || this.dead.has(to) || !this.canReach(from, to)) continue;
      this.enqueue(from, to, msg);
    }
  }

  /** @internal */
  drop(peer: PeerId, reason: DropReason): void {
    this.members.delete(peer);
    for (const key of Array.from(this.pairs.keys())) {
      if (key.split("|").includes(peer)) this.pairs.delete(key);
    }
    this.refresh();
    this.transports.get(peer)?.notifyDropped(reason);
  }

  /** @internal */
  handOff(from: PeerId, to: PeerId): Result<void, HandOffReject> {
    if (this.hostId !== from) return fail("not-host");
    if (this.pairs.get(pairKey(from, to)) !== "active") return fail("target-unavailable");
    this.setHost(to);
    return ok();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private setLink(a: PeerId, b: PeerId, state: LinkState): void {
    this.pairs.set(pairKey(a, b), state);
  }

  private active(a: PeerId, b: PeerId): boolean {
    return this.pairs.get(pairKey(a, b)) === "active";
  }

  /** Star routing: direct with the host, otherwise relayed by it. */
  private canReach(from: PeerId, to: PeerId): boolean {
    const host = this.hostId;
    if (host === undefined || this.dead.has(host)) return false;
    if (from === host) return this.active(host, to);
    if (to === host) return this.active(from, host);
    return this.active(from, host) && this.active(host, to);
  }

  private enqueue(from: PeerId, to: PeerId, msg: Wire): void {
    const copy = JSON.parse(JSON.stringify(msg)) as Wire; // what the wire would carry
    this.sent.push({ from, to, msg: copy });
    this.queue.push({ to, incoming: { from, msg: copy } });
    if (this.options.autoFlush !== false && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.flush();
      });
    }
  }

  private refresh(): void {
    batch(() => {
      for (const [self, transport] of this.transports) {
        const isHost = self === this.hostId;
        const members = new Map<PeerId, Member>();
        for (const peer of this.members) {
          members.set(peer, {
            peerId: peer,
            joinedAt: this.joinedAt.get(peer) ?? 0,
            ...(isHost && this.players.has(peer) && { playerId: this.players.get(peer) }),
          });
        }
        const links = new Map<PeerId, LinkState>();
        for (const peer of this.transports.keys()) {
          if (peer === self) continue;
          const state = this.pairs.get(pairKey(self, peer));
          if (state === undefined) continue;
          if (isHost || peer === this.hostId) links.set(peer, state);
        }
        transport.update({
          role: isHost ? "host" : "guest",
          host: this.hostId,
          members,
          links,
        });
      }
    });
  }
}
