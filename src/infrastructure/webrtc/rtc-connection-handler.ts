// rtc-connection-handler.ts

import type { RtcPeerRegistry } from "./rtc-peer-registry";
import type { RtcPeerEntryFactory } from "./rtc-peer-entry-factory";
import type { RtcHostElectionCoordinator } from "./rtc-host-election-coordinator";
import type { SignalingPeerId } from "@infrastructure/signaling";

const RECONNECT_TIMEOUT_MS = 5_000;

export class RtcConnectionHandler {
  constructor(
    private readonly registry: RtcPeerRegistry,
    private readonly entryFactory: RtcPeerEntryFactory,
    private readonly electionCoordinator: RtcHostElectionCoordinator,
    private readonly isHost: () => boolean,
    private readonly isLeaving: () => boolean,
  ) {}

  async handleConnectionDied(signalingPeerId: SignalingPeerId): Promise<void> {
    if (this.isLeaving()) {
      console.log(
        `[RtcConnectionHandler] Ignoring connection death during leave for peer=${short(signalingPeerId)}`,
      );
      return;
    }

    const entry = this.registry.get(signalingPeerId);
    if (!entry) return;

    console.warn(
      `[RtcConnectionHandler] Connection died for peer=${short(signalingPeerId)}`,
    );
    this.registry.disposeEntry(entry);

    if (this.isHost()) {
      await this.reconnectAsHost(signalingPeerId);
    } else {
      this.reconnectAsGuest(signalingPeerId);
    }
  }

  // Called when guest joins and host document exists but no offer arrives.
  // Also called when connection dies as guest.
  suspectHostDead(deadHostPeerId: SignalingPeerId): void {
    console.log(
      `[RtcConnectionHandler] Suspecting host=${short(deadHostPeerId)} is dead — starting election countdown`,
    );
    this.electionCoordinator.startCountdown(deadHostPeerId);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async reconnectAsHost(
    signalingPeerId: SignalingPeerId,
  ): Promise<void> {
    console.log(
      `[RtcConnectionHandler] Reconnecting as host to peer=${short(signalingPeerId)}`,
    );

    const newEntry = this.entryFactory.create(signalingPeerId);
    newEntry.status = "reconnecting";
    this.registry.replace(signalingPeerId, newEntry);
    this.registry.setStatus(signalingPeerId, "reconnecting");

    await this.entryFactory.initiateOffer(signalingPeerId, newEntry);
  }

  private reconnectAsGuest(signalingPeerId: SignalingPeerId): void {
    console.log(
      `[RtcConnectionHandler] Reconnecting as guest — waiting for new offer from peer=${short(signalingPeerId)}`,
    );

    const reconnectingEntry = this.entryFactory.create(signalingPeerId);
    reconnectingEntry.status = "reconnecting";
    this.registry.replace(signalingPeerId, reconnectingEntry);
    this.registry.setStatus(signalingPeerId, "reconnecting");

    // Tell coordinator this host may be dead.
    // Coordinator starts staggered countdown — cancels automatically
    // via registry watcher if any peer becomes active before it fires.
    this.suspectHostDead(signalingPeerId);

    // Cleanup timer — remove stale entry if no connection established.
    setTimeout(() => {
      if (this.isLeaving()) return;

      const current = this.registry.get(signalingPeerId);
      if (!current || current.status !== "reconnecting") return;

      console.warn(
        `[RtcConnectionHandler] No offer received from peer=${short(signalingPeerId)} — removing entry`,
      );
      this.registry.disposeEntry(current);
      this.registry.remove(signalingPeerId);
    }, RECONNECT_TIMEOUT_MS);
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
