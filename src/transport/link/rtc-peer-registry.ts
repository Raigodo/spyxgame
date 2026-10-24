import {
  Cell,
  Emitter,
  listenerFailure,
  shortId,
  type Logger,
  type PeerId,
  type Store,
} from "@/kernel";
import type { LinkState } from "../model";
import type { PeerEntry, RtcPeer, RtcPeerStatus } from "./types";

export interface RtcPeerRegistryDeps {
  logger: Logger;
}

type LinkMap = ReadonlyMap<PeerId, LinkState>;

function sameLinks(a: LinkMap, b: LinkMap): boolean {
  if (a.size !== b.size) return false;
  for (const [id, state] of a) if (b.get(id) !== state) return false;
  return true;
}

export class RtcPeerRegistry {
  private readonly peers = new Map<PeerId, PeerEntry>();
  private readonly onListenerError = listenerFailure(() => this.deps.logger);
  private readonly linksCell = new Cell<LinkMap>(new Map(), {
    equals: sameLinks,
    onError: this.onListenerError,
  });
  private readonly joined = new Emitter<RtcPeer>(this.onListenerError);
  private readonly left = new Emitter<RtcPeer>(this.onListenerError);
  private readonly statusChanged = new Emitter<RtcPeer>(this.onListenerError);

  constructor(private readonly deps: RtcPeerRegistryDeps) {}

  // ─── Query ────────────────────────────────────────────────────────────────

  /** Every registered link and its state. Updated before any event below fires. */
  get links(): Store<LinkMap> {
    return this.linksCell;
  }

  has(signalingPeerId: PeerId): boolean {
    return this.peers.has(signalingPeerId);
  }

  get(signalingPeerId: PeerId): PeerEntry | undefined {
    return this.peers.get(signalingPeerId);
  }

  getAll(): RtcPeer[] {
    return Array.from(this.peers.entries(), ([signalingPeerId, entry]) => ({
      signalingPeerId,
      status: entry.status,
    }));
  }

  entries(): IterableIterator<[PeerId, PeerEntry]> {
    return this.peers.entries();
  }

  inspect(): Record<string, unknown> {
    return Object.fromEntries(
      Array.from(this.peers, ([id, entry]) => [
        id,
        { status: entry.status, linkState: entry.connection?.getState() ?? null },
      ])
    );
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  add(signalingPeerId: PeerId, entry: PeerEntry): void {
    this.peers.set(signalingPeerId, entry);
    this.syncLinks();
    this.joined.emit({ signalingPeerId, status: entry.status });
  }

  replace(signalingPeerId: PeerId, entry: PeerEntry): void {
    this.peers.set(signalingPeerId, entry);
    this.syncLinks();
  }

  // Removes the entry, announces the departure and closes its link. The entry leaves the map
  // first, so the "connection died" event that closing fires finds nothing to reconnect.
  remove(signalingPeerId: PeerId): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry) return;
    this.peers.delete(signalingPeerId);
    this.syncLinks();
    this.left.emit({ signalingPeerId, status: entry.status });
    this.disposeEntry(entry);
  }

  // Drops an entry without announcing a departure: the peer is still in the room, we just no
  // longer need a link to it. Removed from the map first, for the same reason as remove().
  discard(signalingPeerId: PeerId): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry) return;
    this.peers.delete(signalingPeerId);
    this.syncLinks();
    this.disposeEntry(entry);
  }

  setStatus(signalingPeerId: PeerId, status: RtcPeerStatus): void {
    const entry = this.peers.get(signalingPeerId);
    if (!entry || entry.status === status) return;
    this.deps.logger.debug(`Peer=${shortId(signalingPeerId)} status: ${entry.status} → ${status}`);
    entry.status = status;
    this.syncLinks();
    this.statusChanged.emit({ signalingPeerId, status });
  }

  disposeAndRemoveAll(): void {
    for (const [signalingPeerId, entry] of Array.from(this.peers)) {
      this.peers.delete(signalingPeerId); // first, for the same reason as in discard()
      this.disposeEntry(entry);
      this.left.emit({ signalingPeerId, status: entry.status });
    }
    this.syncLinks();
  }

  disposeEntry(entry: PeerEntry): void {
    entry.connection?.close();
    entry.negotiator.close();
    entry.connection = null;
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  onPeerJoined(handler: (peer: RtcPeer) => void): () => void {
    return this.joined.on(handler);
  }

  onPeerLeft(handler: (peer: RtcPeer) => void): () => void {
    return this.left.on(handler);
  }

  onStatusChanged(handler: (peer: RtcPeer) => void): () => void {
    return this.statusChanged.on(handler);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private syncLinks(): void {
    const next = new Map<PeerId, LinkState>();
    for (const [id, entry] of this.peers) next.set(id, entry.status);
    this.linksCell.set(next);
  }
}
