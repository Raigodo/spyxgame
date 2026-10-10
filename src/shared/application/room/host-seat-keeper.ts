import type { HostClaimStore } from "@/shared/infrastructure/player";
import type { PageLifecycle, Unsubscribe } from "@/shared/kernel";

/** What the keeper needs to know about the local peer. */
export interface SeatSource {
  isHost(): boolean;
  getLocalPeerId(): string | undefined;
}

// Owns the "I was host in this room as peer X" hint: written while host, stamped on pagehide,
// read on the next load, forgotten on a deliberate leave. The rules for when are here, not in
// the client.
export class HostSeatKeeper {
  constructor(
    private readonly claims: HostClaimStore,
    private readonly pageLifecycle: PageLifecycle
  ) {}

  recall(roomId: string, playerId: string) {
    return this.claims.recall(roomId, playerId);
  }

  /** Writes the hint if this peer is host right now. */
  remember(roomId: string, playerId: string, source: SeatSource): void {
    const peerId = source.getLocalPeerId();
    if (source.isHost() && peerId) this.claims.remember(roomId, playerId, peerId);
  }

  /** A refresh fires pagehide: stamp the hint so the reloaded tab knows this page is gone. */
  watchPageHide(roomId: string, source: SeatSource): Unsubscribe {
    return this.pageLifecycle.onPageHide(() => {
      if (source.isHost()) this.claims.markLeaving(roomId);
    });
  }

  /** A deliberate leave (or being superseded or kicked) must never reclaim. */
  forget(roomId: string): void {
    this.claims.forget(roomId);
  }
}
