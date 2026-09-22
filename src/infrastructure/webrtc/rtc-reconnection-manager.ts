// rtc-reconnection-manager.ts

import type {
  HostElectionService,
  SignalingPeerId,
} from "@infrastructure/signaling";
import type { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import type { RtcPeerRegistry } from "./rtc-peer-registry";

const RECONNECT_TIMEOUT_MS = 5_000;
const OFFER_TIMEOUT_MS = 5_000;

export class RtcReconnectionManager {
  private readonly offerWatches = new Map<
    SignalingPeerId,
    ReturnType<typeof setTimeout>
  >();
  private unsubscribeFromRegistry?: () => void;

  constructor(
    private readonly registry: RtcPeerRegistry,
    private readonly linkFactory: RtcPeerLinkFactory,
    private readonly getHostElection: () => HostElectionService,
    private readonly isHost: () => boolean,
    private readonly isLeaving: () => boolean,
  ) {}

  start(): void {
    this.unsubscribeFromRegistry = this.registry.onAnyStatusChanged(
      (status, signalingPeerId) => {
        if (status !== "active") return;

        this.stopWatchingForOffer(signalingPeerId);

        // A healthy connection to the specific peer we were worried about
        // means it's not actually dead — cancel that election. A different,
        // unrelated peer becoming active shouldn't touch it.
        if (
          this.getHostElection().getSuspectedDeadHostId() === signalingPeerId
        ) {
          this.getHostElection().cancelPendingElection();
        }
      },
    );
  }

  stop(): void {
    this.clearAllOfferWatches();
    this.unsubscribeFromRegistry?.();
    this.unsubscribeFromRegistry = undefined;
  }

  // ─── Connection death (an active connection that dropped) ─────────────────

  async handleConnectionDied(signalingPeerId: SignalingPeerId): Promise<void> {
    if (this.isLeaving()) {
      console.log(
        `[RtcReconnectionManager] Ignoring connection death during leave for peer=${short(signalingPeerId)}`,
      );
      return;
    }

    const entry = this.registry.get(signalingPeerId);
    if (!entry) return;

    console.warn(
      `[RtcReconnectionManager] Connection died for peer=${short(signalingPeerId)}`,
    );
    this.registry.disposeEntry(entry);

    if (this.isHost()) {
      await this.reconnectAsHost(signalingPeerId);
    } else {
      this.reconnectAsGuest(signalingPeerId);
    }
  }

  // ─── Missing offer (guest sees a host doc but never gets an offer) ────────

  // Called whenever the local peer learns of a host — fresh join or a new
  // election result — while itself a guest. Starts a timer; if no active
  // connection to that host shows up in time, treats it as a suspected
  // death, same conclusion as a connection that visibly dropped.
  watchForOffer(hostPeerId: SignalingPeerId): void {
    this.stopWatchingForOffer(hostPeerId);

    console.log(
      `[RtcReconnectionManager] Watching for offer from host=${short(hostPeerId)}`,
    );

    const timeout = setTimeout(() => {
      this.offerWatches.delete(hostPeerId);

      if (this.isLeaving() || this.isHost()) return;

      const entry = this.registry.get(hostPeerId);
      if (entry?.status === "active") return;

      console.warn(
        `[RtcReconnectionManager] No offer from host=${short(hostPeerId)} within timeout — suspecting dead`,
      );
      this.suspectHostDead(hostPeerId);
    }, OFFER_TIMEOUT_MS);

    this.offerWatches.set(hostPeerId, timeout);
  }

  stopWatchingForOffer(hostPeerId: SignalingPeerId): void {
    const existing = this.offerWatches.get(hostPeerId);
    if (existing) {
      clearTimeout(existing);
      this.offerWatches.delete(hostPeerId);
    }
  }

  clearAllOfferWatches(): void {
    for (const timeout of this.offerWatches.values()) {
      clearTimeout(timeout);
    }
    this.offerWatches.clear();
  }

  // ─── Shared ─────────────────────────────────────────────────────────────

  suspectHostDead(deadHostPeerId: SignalingPeerId): void {
    console.log(
      `[RtcReconnectionManager] Suspecting host=${short(deadHostPeerId)} is dead`,
    );
    this.getHostElection().reportSuspectedDeath(deadHostPeerId);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async reconnectAsHost(
    signalingPeerId: SignalingPeerId,
  ): Promise<void> {
    console.log(
      `[RtcReconnectionManager] Reconnecting as host to peer=${short(signalingPeerId)}`,
    );

    const newEntry = this.linkFactory.create(signalingPeerId);
    newEntry.status = "reconnecting";
    this.registry.replace(signalingPeerId, newEntry);
    this.registry.setStatus(signalingPeerId, "reconnecting");

    await this.linkFactory.initiateOffer(signalingPeerId, newEntry);
  }

  private reconnectAsGuest(signalingPeerId: SignalingPeerId): void {
    console.log(
      `[RtcReconnectionManager] Reconnecting as guest — waiting for new offer from peer=${short(signalingPeerId)}`,
    );

    const reconnectingEntry = this.linkFactory.create(signalingPeerId);
    reconnectingEntry.status = "reconnecting";
    this.registry.replace(signalingPeerId, reconnectingEntry);
    this.registry.setStatus(signalingPeerId, "reconnecting");

    this.suspectHostDead(signalingPeerId);

    setTimeout(() => {
      if (this.isLeaving()) return;

      const current = this.registry.get(signalingPeerId);
      if (!current || current.status !== "reconnecting") return;

      console.warn(
        `[RtcReconnectionManager] No offer received from peer=${short(signalingPeerId)} — removing entry`,
      );
      this.registry.disposeEntry(current);
      this.registry.remove(signalingPeerId);
    }, RECONNECT_TIMEOUT_MS);
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
