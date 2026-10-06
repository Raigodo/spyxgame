import { shortId, type Cancel, type Clock, type Logger, type WebRtcConfig } from "@/shared/kernel";
import type { HostElectionService, SignalingPeerId } from "../signaling";
import type { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import type { RtcPeerRegistry } from "./rtc-peer-registry";
import { decideDeadLinkAction } from "./link-policy";

export interface RtcReconnectionManagerDeps {
  registry: RtcPeerRegistry;
  linkFactory: RtcPeerLinkFactory;
  getHostElection: () => HostElectionService;
  isHost: () => boolean;
  isLeaving: () => boolean;
  getHostPeerId: () => SignalingPeerId | undefined;
  clock: Clock;
  logger: Logger;
  config: WebRtcConfig;
}

export class RtcReconnectionManager {
  private readonly offerWatches = new Map<SignalingPeerId, Cancel>();
  private unsubscribeFromRegistry?: () => void;

  constructor(private readonly deps: RtcReconnectionManagerDeps) {}

  private get log(): Logger {
    return this.deps.logger;
  }

  start(): void {
    this.unsubscribeFromRegistry = this.deps.registry.onStatusChanged((peer) => {
      if (peer.status !== "active") return;

      this.stopWatchingForOffer(peer.signalingPeerId);

      // A healthy connection to the specific peer we were worried about means it's not actually
      // dead: cancel that election. A different, unrelated peer becoming active shouldn't touch it.
      const election = this.deps.getHostElection();
      if (election.getSuspectedDeadHostId() === peer.signalingPeerId) {
        election.cancelPendingElection();
      }
    });
  }

  stop(): void {
    this.clearAllOfferWatches();
    this.unsubscribeFromRegistry?.();
    this.unsubscribeFromRegistry = undefined;
  }

  // ─── Connection death (an active connection that dropped) ─────────────────

  async handleConnectionDied(signalingPeerId: SignalingPeerId): Promise<void> {
    const { registry, isLeaving, isHost, getHostPeerId } = this.deps;
    const peer = shortId(signalingPeerId);

    if (isLeaving()) {
      this.log.debug(`Ignoring connection death during leave for peer=${peer}`);
      return;
    }

    const entry = registry.get(signalingPeerId);
    if (!entry) return;

    const action = decideDeadLinkAction({
      isHost: isHost(),
      peerId: signalingPeerId,
      hostPeerId: getHostPeerId(),
    });

    if (action === "drop-stale") {
      this.log.debug(`Dropping stale link to peer=${peer}`);
      registry.discard(signalingPeerId);
      return;
    }

    this.log.warn(`Connection died for peer=${peer}`);
    registry.disposeEntry(entry);

    if (action === "reconnect-as-host") await this.reconnectAsHost(signalingPeerId);
    else this.reconnectAsGuest(signalingPeerId);
  }

  // ─── Missing offer (guest sees a host doc but never gets an offer) ────────

  // Called whenever the local peer learns of a host (fresh join or a new election result) while
  // itself a guest. Starts a timer; if no active connection to that host shows up in time, treats
  // it as a suspected death, same conclusion as a connection that visibly dropped.
  watchForOffer(hostPeerId: SignalingPeerId): void {
    const { clock, config, registry, isLeaving, isHost, getHostPeerId } = this.deps;
    this.stopWatchingForOffer(hostPeerId);

    this.log.debug(`Watching for offer from host=${shortId(hostPeerId)}`);

    const cancel = clock.after(config.offerTimeoutMs, () => {
      this.offerWatches.delete(hostPeerId);

      if (isLeaving() || isHost()) return;
      if (getHostPeerId() !== hostPeerId) return; // the host moved on since this watch started
      if (registry.get(hostPeerId)?.status === "active") return;

      this.log.warn(`No offer from host=${shortId(hostPeerId)} within timeout, suspecting dead`);
      this.suspectHostDead(hostPeerId);
    });

    this.offerWatches.set(hostPeerId, cancel);
  }

  stopWatchingForOffer(hostPeerId: SignalingPeerId): void {
    this.offerWatches.get(hostPeerId)?.();
    this.offerWatches.delete(hostPeerId);
  }

  clearAllOfferWatches(): void {
    for (const cancel of this.offerWatches.values()) cancel();
    this.offerWatches.clear();
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  suspectHostDead(deadHostPeerId: SignalingPeerId): void {
    // Only the current host's death is ever a reason to elect. Reporting anyone else removes a
    // live peer from the room.
    if (deadHostPeerId !== this.deps.getHostPeerId()) {
      this.log.debug(
        `Ignoring suspicion about peer=${shortId(deadHostPeerId)}: not the current host`
      );
      return;
    }
    this.log.debug(`Suspecting host=${shortId(deadHostPeerId)} is dead`);
    this.deps.getHostElection().reportSuspectedDeath(deadHostPeerId);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async reconnectAsHost(signalingPeerId: SignalingPeerId): Promise<void> {
    const { registry, linkFactory } = this.deps;
    this.log.debug(`Reconnecting as host to peer=${shortId(signalingPeerId)}`);

    const newEntry = linkFactory.create(signalingPeerId);
    newEntry.status = "reconnecting";
    registry.replace(signalingPeerId, newEntry);
    registry.setStatus(signalingPeerId, "reconnecting");

    await linkFactory.initiateOffer(signalingPeerId, newEntry);
  }

  private reconnectAsGuest(signalingPeerId: SignalingPeerId): void {
    const { registry, linkFactory, clock, config, isLeaving, getHostPeerId } = this.deps;
    this.log.debug(
      `Reconnecting as guest, waiting for new offer from peer=${shortId(signalingPeerId)}`
    );

    const reconnectingEntry = linkFactory.create(signalingPeerId);
    reconnectingEntry.status = "reconnecting";
    registry.replace(signalingPeerId, reconnectingEntry);
    registry.setStatus(signalingPeerId, "reconnecting");

    this.suspectHostDead(signalingPeerId);

    // Not tracked on purpose in this step (behavior unchanged); it becomes a tracked timer in the
    // WebRtcService split.
    clock.after(config.reconnectTimeoutMs, () => {
      if (isLeaving()) return;

      const current = registry.get(signalingPeerId);
      if (!current || current.status !== "reconnecting") return;

      this.log.warn(`No offer received from peer=${shortId(signalingPeerId)}, removing entry`);
      if (signalingPeerId === getHostPeerId()) {
        registry.disposeEntry(current);
        registry.remove(signalingPeerId);
      } else {
        registry.discard(signalingPeerId); // the host moved on: silent, the peer is still in the room
      }
    });
  }
}
