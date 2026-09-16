import type { ParticipantChange } from "./types";

type PeerEventHandler = (peerId: string) => void;

interface ParticipantRecord {
  lastSeenMs: number | null;
}

/**
 * Pure bookkeeping: keeps the set of known peers (and their last heartbeat)
 * for the current room, turns raw Firestore doc-changes into join/leave
 * events, and can flag peers whose heartbeat has gone quiet for too long.
 * Has no Firestore dependency, so it's unit-testable with plain objects:
 *
 *   const tracker = new ParticipantTracker();
 *   tracker.seed([{ peerId: "peer-2", lastSeenMs: Date.now() - 100_000 }]);
 *   tracker.getStalePeers(45_000); // ["peer-2"]
 */
export class ParticipantTracker {
  private known = new Map<string, ParticipantRecord>();
  private joinedHandlers = new Set<PeerEventHandler>();
  private leftHandlers = new Set<PeerEventHandler>();

  /** Registers peers already in the room at join time, without firing "joined" for them. */
  seed(participants: { peerId: string; lastSeenMs: number | null }[]): void {
    participants.forEach((p) =>
      this.known.set(p.peerId, { lastSeenMs: p.lastSeenMs }),
    );
  }

  /** Feed this with every change reported by the gateway's participant listener. */
  handleChange(selfId: string, change: ParticipantChange): void {
    const { peerId, type, lastSeenMs } = change;
    if (peerId === selfId) return;

    if (type === "added") {
      const isNew = !this.known.has(peerId);
      this.known.set(peerId, { lastSeenMs });
      if (isNew) this.joinedHandlers.forEach((cb) => cb(peerId));
      return;
    }

    if (type === "modified") {
      // Heartbeats land here — keep our cached lastSeen current.
      const record = this.known.get(peerId);
      if (record) record.lastSeenMs = lastSeenMs;
      return;
    }

    // type === "removed"
    if (this.known.has(peerId)) {
      this.known.delete(peerId);
      this.leftHandlers.forEach((cb) => cb(peerId));
    }
  }

  /** Peers we're tracking whose last known heartbeat is older than `thresholdMs`. */
  getStalePeers(thresholdMs: number, now: number = Date.now()): string[] {
    const stale: string[] = [];
    this.known.forEach((record, peerId) => {
      if (record.lastSeenMs !== null && now - record.lastSeenMs > thresholdMs) {
        stale.push(peerId);
      }
    });
    return stale;
  }

  /**
   * Locally forgets a peer and fires "left" immediately — used once we've
   * independently decided they're gone (stale heartbeat), rather than
   * waiting for Firestore's own "removed" event, which may never arrive if
   * their doc was never deleted.
   */
  evict(peerId: string): void {
    if (this.known.has(peerId)) {
      this.known.delete(peerId);
      this.leftHandlers.forEach((cb) => cb(peerId));
    }
  }

  /**
   * Resyncs against a fresh read from Firestore — used after a long pause
   * (e.g. a backgrounded tab) where snapshot updates may have been missed
   * entirely. Fires "left" for anyone we thought was here but isn't, and
   * "joined" for anyone present that we never learned about.
   */
  reconcile(freshPeers: { peerId: string; lastSeenMs: number | null }[]): void {
    const freshIds = new Set(freshPeers.map((p) => p.peerId));

    [...this.known.keys()].forEach((knownId) => {
      if (!freshIds.has(knownId)) this.evict(knownId);
    });

    freshPeers.forEach((p) => {
      const isNew = !this.known.has(p.peerId);
      this.known.set(p.peerId, { lastSeenMs: p.lastSeenMs });
      if (isNew) this.joinedHandlers.forEach((cb) => cb(p.peerId));
    });
  }

  get all(): string[] {
    return [...this.known.keys()];
  }

  onJoined(cb: PeerEventHandler): () => void {
    this.joinedHandlers.add(cb);
    return () => this.joinedHandlers.delete(cb);
  }

  onLeft(cb: PeerEventHandler): () => void {
    this.leftHandlers.add(cb);
    return () => this.leftHandlers.delete(cb);
  }

  /** Clears tracked peers and all registered handlers — call when fully leaving a room. */
  reset(): void {
    this.known.clear();
    this.joinedHandlers.clear();
    this.leftHandlers.clear();
  }
}
