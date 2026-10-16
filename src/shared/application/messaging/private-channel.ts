import { Emitter, structurallyEqual } from "@/shared/kernel";
import type { ChannelHost } from "./channel-host";
import type { PeerId } from "./types";

/** The body of a "private" (host to owner) or "mine" (owner to host) wire message. */
export interface PieceWire {
  ch: string;
  round: number;
  rev: number;
  value: unknown;
}

/** The revisions the replicated game state says exist. A piece is current only if it matches. */
export interface SlotRevisions {
  round: number;
  privateRev: Readonly<Record<string, number>>;
}

/** What the host changed for one player. value null: the piece was removed (rev 0). */
export interface PrivateWrite {
  playerId: string;
  round: number;
  rev: number;
  value: unknown | null;
}

export interface PrivateView<H> {
  get(playerId: string): H | undefined;
}

export interface PrivateChannelOptions<H> {
  id: string;
  /** Network input: a sanitized piece, or undefined to reject. */
  validate(value: unknown): H | undefined;
  getLocalPlayerId(): string | undefined;
  /** Host side: the durable player behind a verified sender. */
  resolveOwner(peerId: PeerId): string | undefined;
  /** Host side: where a player's piece goes now (undefined: not reachable). */
  resolvePeer(playerId: string): PeerId | undefined;
  getRevisions(): SlotRevisions | undefined;
}

/** What the bus calls on a private channel, whatever its piece type. */
export interface BusPrivateChannel {
  readonly id: string;
  isSynced(): boolean;
  receivePiece(w: PieceWire): void;
  receiveOffer(from: PeerId, w: PieceWire): void;
  offerTo(hostId: PeerId): void;
  acceptOffers(): void;
  onLinkActive(peerId: PeerId): void;
  pruneToOwn(): void;
}

interface Piece<H> {
  round: number;
  rev: number;
  value: H | null;
}

// Per-player values that only their owner may see. The host holds everyone's (in memory, never in
// the replicated state); a guest holds only its own. The replicated state carries just the
// revisions, so a piece that does not match them is stale or missing and is never shown.
export class PrivateChannel<H> implements BusPrivateChannel {
  private readonly pieces = new Map<string, Piece<H>>();
  /** playerId -> "peer:round:rev" last sent, so nothing is sent twice. */
  private readonly delivered = new Map<string, string>();
  private readonly offers = new Map<string, Piece<H>>();
  private readonly mineChanged = new Emitter();

  /** @internal use RoomBus.privateChannel() */
  constructor(
    private readonly host: ChannelHost,
    readonly id: string,
    private readonly opts: PrivateChannelOptions<H>
  ) {}

  // ─── Reading ──────────────────────────────────────────────────────────────

  /** This player's own piece, if it matches `slot`. Same reference until it is replaced. */
  getMine(slot: SlotRevisions): H | undefined {
    const me = this.opts.getLocalPlayerId();
    return me === undefined ? undefined : this.current(me, slot);
  }

  /** Host side: every player's piece, as of `slot`. */
  view(slot: SlotRevisions): PrivateView<H> {
    return { get: (playerId) => this.current(playerId, slot) };
  }

  onMineChanged(handler: () => void): () => void {
    return this.mineChanged.on(handler);
  }

  private current(playerId: string, slot: SlotRevisions): H | undefined {
    const piece = this.pieces.get(playerId);
    if (!piece || piece.value === null) return undefined;
    return piece.round === slot.round && piece.rev === slot.privateRev[playerId]
      ? piece.value
      : undefined;
  }

  // ─── Host ─────────────────────────────────────────────────────────────────

  /** Stores the changes and sends them to their owners. Call before publishing the slot that references them. */
  commit(writes: readonly PrivateWrite[]): void {
    if (writes.length === 0) return;
    const me = this.opts.getLocalPlayerId();
    for (const w of writes) {
      this.pieces.set(w.playerId, { round: w.round, rev: w.rev, value: w.value as H | null });
      if (w.playerId === me) this.mineChanged.emit();
    }
    this.flush();
  }

  /** A new round: pieces of other rounds are dropped. */
  startRound(round: number): void {
    for (const [playerId, piece] of Array.from(this.pieces)) {
      if (piece.round !== round) this.pieces.delete(playerId);
    }
    this.delivered.clear();
    this.offers.clear();
  }

  /** No game is running. */
  clear(): void {
    this.pieces.clear();
    this.delivered.clear();
    this.offers.clear();
  }

  /** Sends every piece that its owner's current link has not received yet. Safe to call any time. */
  flush(): void {
    const { transport } = this.host;
    if (!transport.isHost()) return;
    const me = this.opts.getLocalPlayerId();
    for (const [playerId, piece] of this.pieces) {
      if (playerId === me) continue;
      const peer = this.opts.resolvePeer(playerId);
      if (peer === undefined || !transport.isLinkActive(peer)) continue;
      const key = `${peer}:${piece.round}:${piece.rev}`;
      if (this.delivered.get(playerId) === key) continue;
      this.delivered.set(playerId, key);
      this.host.sendTo(peer, {
        __bus: 1,
        kind: "private",
        ch: this.id,
        round: piece.round,
        rev: piece.rev,
        value: piece.value,
      });
    }
  }

  /** A link to `peerId` came up: whatever it was sent before may be lost. */
  onLinkActive(peerId: PeerId): void {
    const owner = this.opts.resolveOwner(peerId);
    if (owner !== undefined) this.delivered.delete(owner);
    this.flush();
  }

  /** @internal A guest offered its own piece (also its way of asking for it again). */
  receiveOffer(from: PeerId, w: PieceWire): void {
    const owner = this.opts.resolveOwner(from);
    if (owner === undefined) return;
    const held = this.pieces.get(owner);
    if (w.value === null) {
      if (held && held.value !== null) this.delivered.delete(owner); // it lacks the piece: send again
    } else {
      const value = this.opts.validate(w.value);
      if (value !== undefined) this.offers.set(owner, { round: w.round, rev: w.rev, value });
      if (held && (held.round !== w.round || held.rev !== w.rev)) this.delivered.delete(owner);
    }
    if (this.host.canPublish()) this.acceptOffers(); // during recovery the bus calls it afterwards
  }

  /** @internal Adopts offered pieces that match the replicated revisions, then sends what is missing. */
  acceptOffers(): void {
    const revisions = this.opts.getRevisions();
    for (const [owner, offer] of this.offers) {
      const matches =
        revisions !== undefined &&
        offer.round === revisions.round &&
        offer.rev === revisions.privateRev[owner];
      if (!matches) continue;
      const held = this.pieces.get(owner);
      if (held && held.value !== null && held.round === offer.round && held.rev === offer.rev) {
        continue;
      }
      this.pieces.set(owner, offer);
      const peer = this.opts.resolvePeer(owner);
      if (peer !== undefined) this.delivered.set(owner, `${peer}:${offer.round}:${offer.rev}`); // the owner has it
    }
    this.offers.clear();
    this.flush();
  }

  /** Lost the host role: keep only our own piece. */
  pruneToOwn(): void {
    const me = this.opts.getLocalPlayerId();
    for (const playerId of Array.from(this.pieces.keys())) {
      if (playerId !== me) this.pieces.delete(playerId);
    }
    this.delivered.clear();
    this.offers.clear();
  }

  // ─── Guest ────────────────────────────────────────────────────────────────

  /** @internal Our piece from the host (the bus has checked the sender). */
  receivePiece(w: PieceWire): void {
    const me = this.opts.getLocalPlayerId();
    if (me === undefined) return;
    const prev = this.pieces.get(me);
    if (w.value === null) {
      if (prev?.value === null && prev.round === w.round) return;
      this.pieces.set(me, { round: w.round, rev: w.rev, value: null });
      this.mineChanged.emit();
      return;
    }
    const value = this.opts.validate(w.value);
    if (value === undefined) return;
    if (
      prev &&
      prev.round === w.round &&
      prev.rev === w.rev &&
      structurallyEqual(prev.value, value)
    ) {
      return;
    }
    this.pieces.set(me, { round: w.round, rev: w.rev, value });
    this.mineChanged.emit();
  }

  /** Sends our own piece (or "none") to the host. Never sends anyone else's. */
  offerTo(hostId: PeerId): void {
    const me = this.opts.getLocalPlayerId();
    const piece = me === undefined ? undefined : this.pieces.get(me);
    this.host.sendTo(hostId, {
      __bus: 1,
      kind: "mine",
      ch: this.id,
      round: piece?.round ?? 0,
      rev: piece?.rev ?? 0,
      value: piece?.value ?? null,
    });
  }

  /** True when the replicated state expects a piece for us and we hold it (or expects none). */
  isSynced(): boolean {
    if (this.host.transport.isHost()) return true;
    const me = this.opts.getLocalPlayerId();
    const revisions = this.opts.getRevisions();
    if (me === undefined || revisions === undefined) return true;
    const expected = revisions.privateRev[me];
    if (expected === undefined) return true;
    const piece = this.pieces.get(me);
    return (
      piece !== undefined &&
      piece.value !== null &&
      piece.round === revisions.round &&
      piece.rev === expected
    );
  }
}
