import type { WebRtcService } from "./web-rtc-service";

/** The part of WebRtcService that PlayerSession needs. A test fake only implements these. */
export type RtcTransport = Pick<
  WebRtcService,
  | "joinRoom"
  | "leaveRoom"
  | "removePeer"
  | "transferHost"
  | "getPeers"
  | "getMemberPeerIds"
  | "getLocalPeerId"
  | "getHostPeerId"
  | "isHost"
  | "onPeerLeft"
  | "onHostChanged"
  | "onPeerStatusChanged"
  | "inspect"
>;
