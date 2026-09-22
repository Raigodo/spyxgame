import { SignalingPeerId } from "../signaling";

export type RtcPeerId = string;

export type RtcPeerStatus = "connecting" | "active" | "reconnecting";

export interface RtcPeerInfo {
  rtcPeerId: RtcPeerId;
  signalingPeerId: SignalingPeerId;
  status: RtcPeerStatus;
}

export type RtcMessage = string | object | ArrayBuffer;
