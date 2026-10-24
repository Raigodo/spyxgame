export type { RoomMembershipPort } from "./signaling/ports/room-membership-port";
export type { SignalInboxPort } from "./signaling/ports/signal-inbox-port";
export type {
  CandidateStage,
  HostDocument,
  HostElectionPort,
} from "./signaling/ports/host-election-port";
export type { RtcConnectionProvider } from "./link/ports/rtc-connection-provider";
export type { RtcDataChannelPort } from "./link/ports/rtc-data-channel-port";
export type {
  IceCandidate,
  PeerConnectionState,
  RtcPeerConnectionPort,
  SessionDescription,
} from "./link/ports/rtc-peer-connection-port";

import type { IceServer } from "./config";

/** Relay servers, resolved once per join. A failure or timeout means STUN-only. */
export interface IceServerSource {
  fetch(): Promise<readonly IceServer[]>;
}
