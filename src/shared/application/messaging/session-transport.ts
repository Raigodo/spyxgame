// application/messaging/session-transport.ts
import type { PlayerSession } from "@/shared/infrastructure/player";
import type { BusTransport } from "./types";

export function createSessionTransport(session: PlayerSession): BusTransport {
  return {
    getLocalPeerId: () => session.getLocalPlayer()?.peerId,
    getHostPeerId: () => session.getHostPeerId(),
    isHost: () => session.isHost(),
    send: (to, payload) => session.sendToPlayer(to, payload),
    broadcast: (payload) => session.broadcast(payload),
    onMessage: (handler) => session.onMessage(handler),
    onHostChanged: (handler) => session.onHostChanged(() => handler()),
    onLinkActive: (handler) =>
      session.onPeerConnectionStatusChanged((peer) => {
        if (peer.status === "active") handler(peer.signalingPeerId);
      }),
    isLinkActive: (peerId) => session.getPeerConnectionStatus(peerId) === "active",
    getExpectedPeerIds: () => session.getPeerIds(), // new method, see infrastructure-patches.md
  };
}
