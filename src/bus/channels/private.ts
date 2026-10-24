// Per-player values that only their owner may see. The host holds everyone's (in memory, never in
// the replicated state); a guest holds only its own. The replicated state carries just the
// revisions, so a piece that does not match them is stale or missing and is never shown.

import {
  Cell,
  derived,
  structurallyEqual,
  type ChannelId,
  type PeerId,
  type PlayerId,
  type Scope,
  type Store,
} from "@/kernel";
import type { PrivateDef, PrivateHandle, PrivateWrite } from "../model";
import type { BusMsgOf } from "../wire";
import type { ChannelHost } from "./host";
import type { PrivateSink } from "./state";

/** The body of a "private" (host to owner) or "mine" (owner to host) wire message. */
export type PieceMsg = BusMsgOf<"private"> | BusMsgOf<"mine">;

/** What the bus calls on a private channel, whatever its piece type. */
export interface BusPrivateChannel extends PrivateSink {
  readonly id: ChannelId;
  readonly synced: Store<boolean>;
  isSynced(): boolean;
  receivePiece(msg: PieceMsg): void;
  receiveOffer(from: PeerId, msg: PieceMsg): void;
  offerTo(hostId: PeerId): void;
  /** Host: adopts offered pieces that match the replicated revisions, then sends what is missing. */
  acceptOffers(): void;
  onLinkActive(peer: PeerId): void;
  /** Lost the host role: keep only our own piece. */
  pruneToOwn(): void;
}

interface Piece<P> {
  round: number;
  rev: number;
  value: P | null;
}

export class PrivateChannel<P, S> implements PrivateHandle<P>, BusPrivateChannel {
  readonly id: ChannelId;
  readonly mine: Store<P | undefined>;
  readonly synced: Store<boolean>;
  private readonly pieces = new Map<PlayerId, Piece<P>>();
  /** playerId -> "peer:round:rev" last sent, so nothing is sent twice. */
  private readonly delivered = new Map<PlayerId, string>();
  private readonly offers = new Map<PlayerId, Piece<P>>();
  private readonly tick = new Cell(0);

  constructor(private readonly deps: { host: ChannelHost; def: PrivateDef<P, S>; scope: Scope }) {
    const { host, def, scope } = deps;
    this.id = def.id;
    this.mine = derived([def.of.value, this.tick] as const, (state) =>
      this.currentFor(host.localPlayerId, state)
    );
    this.synced = derived([def.of.value, this.tick, host.role] as const, (state, _tick, role) =>
      this.computeSynced(state, role === "host")
    );
    scope.watch(def.of.value, (state) => this.dropStale(state));
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /** Host side: any player's piece, as of the replicated revisions. */
  view(playerId: PlayerId): P | undefined {
    return this.currentFor(playerId, this.deps.def.of.value.get());
  }

  private revisions(state: S | undefined) {
    return state === undefined ? undefined : this.deps.def.revisions(state);
  }

  private currentFor(playerId: PlayerId, state: S | undefined): P | undefined {
    const revisions = this.revisions(state);
    const piece = this.pieces.get(playerId);
    if (!revisions || !piece || piece.value === null) return undefined;
    return piece.round === revisions.round && piece.rev === revisions.rev[playerId]
      ? piece.value
      : undefined;
  }

  /** The replicated state moved on: pieces of other rounds, or of no game, are dropped. */
  private dropStale(state: S | undefined): void {
    if (state === undefined) return;
    const revisions = this.deps.def.revisions(state);
    let dropped = false;
    for (const [playerId, piece] of Array.from(this.pieces)) {
      if (revisions === undefined || piece.round !== revisions.round) {
        this.pieces.delete(playerId);
        dropped = true;
      }
    }
    if (!dropped) return;
    this.delivered.clear();
    this.offers.clear();
    this.bump();
  }

  private bump(): void {
    this.tick.set(this.tick.get() + 1);
  }

  // ─── Host ─────────────────────────────────────────────────────────────────

  /** Stores the changes and sends them to their owners. The state channel calls it before it publishes. */
  commit(writes: readonly PrivateWrite[]): void {
    if (writes.length === 0) return;
    const me = this.deps.host.localPlayerId;
    let mineChanged = false;
    for (const w of writes) {
      this.pieces.set(w.playerId, { round: w.round, rev: w.rev, value: w.value as P | null });
      if (w.playerId === me) mineChanged = true;
    }
    if (mineChanged) this.bump();
    this.flush();
  }

  /** Sends every piece that its owner's current link has not received yet. Safe to call any time. */
  flush(): void {
    const { host } = this.deps;
    if (!host.isHost()) return;
    for (const [playerId, piece] of this.pieces) {
      if (playerId === host.localPlayerId) continue;
      const peer = host.peerOf(playerId);
      if (peer === undefined || !host.linkActive(peer)) continue;
      const key = `${peer}:${piece.round}:${piece.rev}`;
      if (this.delivered.get(playerId) === key) continue;
      this.delivered.set(playerId, key);
      host.sendTo(peer, {
        kind: "private",
        ch: this.id,
        round: piece.round,
        rev: piece.rev,
        value: piece.value as BusMsgOf<"private">["value"],
      });
    }
  }

  /** A link to `peer` came up: whatever it was sent before may be lost. */
  onLinkActive(peer: PeerId): void {
    const owner = this.deps.host.playerOf(peer);
    if (owner !== undefined) this.delivered.delete(owner);
    this.flush();
  }

  /** A guest offered its own piece (also its way of asking for it again). */
  receiveOffer(from: PeerId, msg: PieceMsg): void {
    const { host, def } = this.deps;
    const owner = host.playerOf(from);
    if (owner === undefined) return;
    const held = this.pieces.get(owner);
    if (msg.value === null) {
      if (held && held.value !== null) this.delivered.delete(owner); // it lacks the piece: send again
    } else {
      const value = def.schema.parse(msg.value);
      if (value !== undefined) this.offers.set(owner, { round: msg.round, rev: msg.rev, value });
      if (held && (held.round !== msg.round || held.rev !== msg.rev)) this.delivered.delete(owner);
    }
    if (host.canCommit()) this.acceptOffers(); // during recovery the flow calls it afterwards
  }

  acceptOffers(): void {
    const revisions = this.revisions(this.deps.def.of.value.get());
    let adopted = false;
    for (const [owner, offer] of this.offers) {
      const matches =
        revisions !== undefined &&
        offer.round === revisions.round &&
        offer.rev === revisions.rev[owner];
      if (!matches) continue;
      const held = this.pieces.get(owner);
      if (held && held.value !== null && held.round === offer.round && held.rev === offer.rev) {
        continue;
      }
      this.pieces.set(owner, offer);
      adopted = true;
      const peer = this.deps.host.peerOf(owner);
      if (peer !== undefined) this.delivered.set(owner, `${peer}:${offer.round}:${offer.rev}`); // the owner has it
    }
    this.offers.clear();
    if (adopted) this.bump();
    this.flush();
  }

  pruneToOwn(): void {
    const me = this.deps.host.localPlayerId;
    for (const playerId of Array.from(this.pieces.keys())) {
      if (playerId !== me) this.pieces.delete(playerId);
    }
    this.delivered.clear();
    this.offers.clear();
  }

  // ─── Guest ────────────────────────────────────────────────────────────────

  /** Our piece from the host (the flow has checked the sender). */
  receivePiece(msg: PieceMsg): void {
    const me = this.deps.host.localPlayerId;
    const prev = this.pieces.get(me);
    if (msg.value === null) {
      if (prev?.value === null && prev.round === msg.round) return;
      this.pieces.set(me, { round: msg.round, rev: msg.rev, value: null });
      this.bump();
      return;
    }
    const value = this.deps.def.schema.parse(msg.value);
    if (value === undefined) return;
    if (
      prev &&
      prev.round === msg.round &&
      prev.rev === msg.rev &&
      structurallyEqual(prev.value, value)
    ) {
      return;
    }
    this.pieces.set(me, { round: msg.round, rev: msg.rev, value });
    this.bump();
  }

  /** Sends our own piece (or "none") to the host. Never sends anyone else's. */
  offerTo(hostId: PeerId): void {
    const piece = this.pieces.get(this.deps.host.localPlayerId);
    this.deps.host.sendTo(hostId, {
      kind: "mine",
      ch: this.id,
      round: piece?.round ?? 0,
      rev: piece?.rev ?? 0,
      value: (piece?.value ?? null) as BusMsgOf<"mine">["value"],
    });
  }

  isSynced(): boolean {
    return this.synced.get();
  }

  /** True when the replicated state expects a piece for us and we hold it (or expects none). */
  private computeSynced(state: S | undefined, isHost: boolean): boolean {
    if (isHost) return true;
    const me = this.deps.host.localPlayerId;
    const revisions = this.revisions(state);
    const expected = revisions?.rev[me];
    if (revisions === undefined || expected === undefined) return true;
    const piece = this.pieces.get(me);
    return (
      piece !== undefined &&
      piece.value !== null &&
      piece.round === revisions.round &&
      piece.rev === expected
    );
  }
}
