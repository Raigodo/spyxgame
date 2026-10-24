import type { PeerId } from "@/kernel";
import type { LinkState } from "../model";
import type { ActiveRtcConnection } from "./active-rtc-connection";
import type { RtcLinkNegotiator } from "./rtc-link-negotiator";

export type RtcPeerStatus = LinkState;

export interface PeerEntry {
  negotiator: RtcLinkNegotiator;
  connection: ActiveRtcConnection | null;
  status: RtcPeerStatus;
}

export interface RtcPeer {
  signalingPeerId: PeerId;
  status: RtcPeerStatus;
}

export type HostTransferResult = "transferred" | "not-host" | "target-unavailable" | "host-changed";

/** A refreshed host's previous incarnation, from the host-claim hint. */
export interface FormerHost {
  peerId: PeerId;
  /** True when pagehide fired just before this load: the old page is known to be gone. */
  confirmedGone: boolean;
}
