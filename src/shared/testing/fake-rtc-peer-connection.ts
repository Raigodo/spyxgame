import type { RtcDataChannelPort } from "@/shared/infrastructure/webrtc/ports/rtc-data-channel-port";
import type {
  IceCandidate,
  PeerConnectionState,
  RtcPeerConnectionPort,
  SessionDescription,
} from "@/shared/infrastructure/webrtc/ports/rtc-peer-connection-port";
import { FakeRtcDataChannel } from "./fake-rtc-data-channel";
import type { FakeRtcNetwork } from "./fake-rtc-network";

// Offers and answers carry the connection id (`fake-offer:conn-1`), so applying an answer finds
// the other side. The link opens once the offerer applies the answer. One fake ICE candidate is
// emitted per local description, after the offer or answer has been sent (macrotask).
export class FakeRtcPeerConnection implements RtcPeerConnectionPort {
  readonly id: string;
  private channel?: FakeRtcDataChannel;
  private remote?: FakeRtcPeerConnection;
  private closed = false;
  private candidateHandler?: (candidate: IceCandidate) => void;
  private stateHandler?: (state: PeerConnectionState) => void;
  private dataChannelHandler?: (channel: RtcDataChannelPort) => void;

  constructor(
    readonly owner: string,
    private readonly network: FakeRtcNetwork
  ) {
    this.id = network.register(this);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get remoteConnection(): FakeRtcPeerConnection | undefined {
    return this.remote;
  }

  createDataChannel(): RtcDataChannelPort {
    this.channel = new FakeRtcDataChannel();
    return this.channel;
  }

  async createOffer(): Promise<SessionDescription> {
    return { type: "offer", sdp: `fake-offer:${this.id}` };
  }

  async createAnswer(): Promise<SessionDescription> {
    return { type: "answer", sdp: `fake-answer:${this.id}` };
  }

  async setLocalDescription(): Promise<void> {
    setImmediate(() => {
      if (this.closed) return;
      this.candidateHandler?.({
        candidate: `fake-candidate:${this.id}`,
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });
  }

  async setRemoteDescription(description: SessionDescription): Promise<void> {
    const remoteId = description.sdp.slice(description.sdp.indexOf(":") + 1);
    const remote = this.network.get(remoteId);
    if (!remote) throw new Error(`[FakeRtcPeerConnection] Unknown remote "${remoteId}"`);
    this.remote = remote;
    if (description.type === "answer") queueMicrotask(() => this.link(remote));
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
  }

  onIceCandidate(handler: (candidate: IceCandidate) => void): void {
    this.candidateHandler = handler;
  }

  onConnectionState(handler: (state: PeerConnectionState) => void): void {
    this.stateHandler = handler;
  }

  onDataChannel(handler: (channel: RtcDataChannelPort) => void): void {
    this.dataChannelHandler = handler;
  }

  /** This side's tab died: nothing fires here. */
  drop(): void {
    this.closed = true;
    this.channel?.drop();
  }

  /** The far side vanished: what a browser reports when the other tab dies. */
  lost(): void {
    if (this.closed) return;
    this.channel?.end();
    this.stateHandler?.("disconnected");
  }

  private link(remote: FakeRtcPeerConnection): void {
    const near = this.channel;
    if (!near || this.closed || remote.closed) return;
    const far = new FakeRtcDataChannel();
    near.peer = far;
    far.peer = near;
    remote.channel = far;
    remote.dataChannelHandler?.(far);
    near.markOpen();
    far.markOpen();
    near.fireOpen();
    far.fireOpen();
  }
}
