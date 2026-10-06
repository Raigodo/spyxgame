import type { RtcDataChannelPort } from "./rtc-data-channel-port";

export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** Same fields as RTCIceCandidateInit, without depending on DOM types. */
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** "other" covers new and connecting. */
export type PeerConnectionState = "connected" | "disconnected" | "failed" | "closed" | "other";

/** Each `on…` replaces the previous handler for that event. */
export interface RtcPeerConnectionPort {
  createDataChannel(label: string): RtcDataChannelPort;
  createOffer(): Promise<SessionDescription>;
  createAnswer(): Promise<SessionDescription>;
  setLocalDescription(description: SessionDescription): Promise<void>;
  setRemoteDescription(description: SessionDescription): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  close(): void;
  onIceCandidate(handler: (candidate: IceCandidate) => void): void;
  onConnectionState(handler: (state: PeerConnectionState) => void): void;
  /** Guest side: the host created the channel. */
  onDataChannel(handler: (channel: RtcDataChannelPort) => void): void;
}
