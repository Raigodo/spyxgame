import type { RtcDataChannelPort } from "../../ports/rtc-data-channel-port";
import type {
  IceCandidate,
  PeerConnectionState,
  RtcPeerConnectionPort,
  SessionDescription,
} from "../../ports/rtc-peer-connection-port";
import { BrowserRtcDataChannelAdapter } from "./browser-rtc-data-channel-adapter";

export class BrowserRtcPeerConnectionAdapter implements RtcPeerConnectionPort {
  constructor(private readonly connection: RTCPeerConnection) {}

  createDataChannel(label: string): RtcDataChannelPort {
    // Default options: ordered and reliable.
    return new BrowserRtcDataChannelAdapter(this.connection.createDataChannel(label));
  }

  async createOffer(): Promise<SessionDescription> {
    const offer = await this.connection.createOffer();
    return { type: "offer", sdp: offer.sdp ?? "" };
  }

  async createAnswer(): Promise<SessionDescription> {
    const answer = await this.connection.createAnswer();
    return { type: "answer", sdp: answer.sdp ?? "" };
  }

  async setLocalDescription(description: SessionDescription): Promise<void> {
    await this.connection.setLocalDescription(description);
  }

  async setRemoteDescription(description: SessionDescription): Promise<void> {
    await this.connection.setRemoteDescription(description);
  }

  async addIceCandidate(candidate: IceCandidate): Promise<void> {
    await this.connection.addIceCandidate(candidate);
  }

  close(): void {
    this.connection.close();
  }

  onIceCandidate(handler: (candidate: IceCandidate) => void): void {
    this.connection.onicecandidate = (event) => {
      if (event.candidate) handler(event.candidate.toJSON());
    };
  }

  onConnectionState(handler: (state: PeerConnectionState) => void): void {
    this.connection.onconnectionstatechange = () => {
      const native = this.connection.connectionState;
      handler(
        native === "connected" ||
          native === "disconnected" ||
          native === "failed" ||
          native === "closed"
          ? native
          : "other"
      );
    };
  }

  onDataChannel(handler: (channel: RtcDataChannelPort) => void): void {
    this.connection.ondatachannel = (event) =>
      handler(new BrowserRtcDataChannelAdapter(event.channel));
  }
}
