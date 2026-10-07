import type { SignalingPeerId } from "../signaling";
import type { ActiveRtcConnection } from "./active-rtc-connection";
import type { RtcLinkNegotiator } from "./rtc-link-negotiator";

export type RtcPeerStatus = "connecting" | "active" | "reconnecting";

export interface PeerEntry {
  negotiator: RtcLinkNegotiator;
  connection: ActiveRtcConnection | null;
  status: RtcPeerStatus;
}

export interface RtcPeer {
  signalingPeerId: SignalingPeerId;
  status: RtcPeerStatus;
}

export type HostTransferResult = "transferred" | "not-host" | "target-unavailable" | "host-changed";

/** A refreshed host's previous incarnation, from the host-claim hint. */
export interface FormerHost {
  peerId: SignalingPeerId;
  /** True when pagehide fired just before this load: the old page is known to be gone. */
  confirmedGone: boolean;
}
