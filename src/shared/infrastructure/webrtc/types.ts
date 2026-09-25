import { SignalingPeerId } from "../signaling";
import { ActiveRtcConnection } from "./active-rtc-connection";
import { RtcConnectionFactory } from "./rtc-connection-factory";

export type RtcPeerId = string;

export type RtcPeerStatus = "connecting" | "active" | "reconnecting";

export interface RtcPeerInfo {
  rtcPeerId: RtcPeerId;
  signalingPeerId: SignalingPeerId;
  status: RtcPeerStatus;
}

export type RtcMessage = string | object | ArrayBuffer;

export interface PeerEntry {
  factory: RtcConnectionFactory;
  connection: ActiveRtcConnection | null;
  status: RtcPeerStatus;
}

export interface RtcPeer {
  signalingPeerId: SignalingPeerId;
  status: RtcPeerStatus;
}
