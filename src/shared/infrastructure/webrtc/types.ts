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
