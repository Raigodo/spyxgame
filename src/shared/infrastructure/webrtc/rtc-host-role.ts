import { shortId, type Logger } from "@/shared/kernel";
import type { SignalingPeerId, SignalingSession } from "../signaling";
import type { RtcPeerLinkFactory } from "./rtc-peer-link-factory";
import type { RtcPeerRegistry } from "./rtc-peer-registry";

export interface RtcHostRoleDeps {
  session: SignalingSession;
  registry: RtcPeerRegistry;
  linkFactory: RtcPeerLinkFactory;
  logger: Logger;
}

// Whether this peer is host, and what only a host does: open a link to every peer (the star
// topology), now for the peers already in the room and later for each one that joins.
export class RtcHostRole {
  private host = false;

  constructor(private readonly deps: RtcHostRoleDeps) {}

  isHost(): boolean {
    return this.host;
  }

  /** Start of a join: nobody is host yet. */
  reset(): void {
    this.host = false;
  }

  async setRole(isHost: boolean): Promise<void> {
    const { session, registry, linkFactory, logger } = this.deps;
    if (this.host === isHost) return;

    logger.debug(`Role changing: ${this.host ? "host" : "guest"} → ${isHost ? "host" : "guest"}`);
    this.host = isHost;

    if (!isHost) return; // links to everyone except the new host are left open on purpose

    logger.debug("Became host, connecting to unconnected peers");
    for (const peer of session.getPeers()) {
      if (registry.has(peer.peerId)) {
        logger.debug(`Already have entry for peer=${shortId(peer.peerId)}, keeping`);
        continue;
      }
      logger.debug(`No entry for peer=${shortId(peer.peerId)}, creating and offering`);
      const entry = linkFactory.create(peer.peerId);
      registry.add(peer.peerId, entry);
      await linkFactory.initiateOffer(peer.peerId, entry);
    }
  }

  /** A peer joined the room. Only the host reaches out to it. */
  async offerToNewPeer(signalingPeerId: SignalingPeerId): Promise<void> {
    const { registry, linkFactory, logger } = this.deps;
    if (!this.host) return;
    if (registry.has(signalingPeerId)) {
      logger.warn(`Peer=${shortId(signalingPeerId)} already exists, skipping`);
      return;
    }

    const entry = linkFactory.create(signalingPeerId);
    registry.add(signalingPeerId, entry);
    await linkFactory.initiateOffer(signalingPeerId, entry);
  }
}
