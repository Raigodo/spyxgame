import type { RtcMessage } from "./types";

type NativeRtcConnectionStateHandler = (state: RTCPeerConnectionState) => void;
type NativeRtcMessageHandler = (message: RtcMessage) => void;

const DATA_CHANNEL_LABEL = "data";

export class NativeRtcConnection {
  private readonly connection: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;

  private readonly stateHandlers = new Set<NativeRtcConnectionStateHandler>();
  private readonly messageHandlers = new Set<NativeRtcMessageHandler>();

  private disposed = false;

  constructor(
    private readonly label: string,
    connection: RTCPeerConnection,
  ) {
    this.connection = connection;

    this.connection.onconnectionstatechange = () => {
      const state = this.connection.connectionState;
      console.log(
        `[NativeRtcConnection][${this.label}] State changed: ${state}`,
      );
      for (const handler of this.stateHandlers) {
        handler(state);
      }
    };

    this.connection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(
          `[NativeRtcConnection][${this.label}] ICE candidate generated`,
        );
      }
    };
  }

  // ─── Offer/Answer ────────────────────────────────────────────────────────

  async createOfferAsHost(): Promise<RTCSessionDescriptionInit> {
    this.assertNotDisposed();

    // Host creates the data channel.
    this.dataChannel = this.connection.createDataChannel(DATA_CHANNEL_LABEL);
    this.attachDataChannelHandlers(this.dataChannel);

    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);

    console.log(`[NativeRtcConnection][${this.label}] Offer created`);
    return offer;
  }

  async receiveOfferAsGuest(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    this.assertNotDisposed();

    // Guest receives the data channel from host.
    this.connection.ondatachannel = (event) => {
      console.log(`[NativeRtcConnection][${this.label}] Data channel received`);
      this.dataChannel = event.channel;
      this.attachDataChannelHandlers(this.dataChannel);
    };

    await this.connection.setRemoteDescription(offer);
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);

    console.log(`[NativeRtcConnection][${this.label}] Answer created`);
    return answer;
  }

  async receiveAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    this.assertNotDisposed();
    await this.connection.setRemoteDescription(answer);
    console.log(`[NativeRtcConnection][${this.label}] Answer received`);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.assertNotDisposed();
    await this.connection.addIceCandidate(candidate);
  }

  onIceCandidate(
    handler: (candidate: RTCIceCandidateInit) => void,
  ): () => void {
    const wrapped = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        handler(event.candidate.toJSON());
      }
    };
    this.connection.addEventListener("icecandidate", wrapped);
    return () => this.connection.removeEventListener("icecandidate", wrapped);
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  send(message: RtcMessage): void {
    this.assertNotDisposed();

    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error(
        `[NativeRtcConnection][${this.label}] Data channel is not open.`,
      );
    }

    if (typeof message === "string") {
      this.dataChannel.send(message);
    } else if (message instanceof ArrayBuffer) {
      this.dataChannel.send(message);
    } else {
      this.dataChannel.send(JSON.stringify(message));
    }
  }

  onMessage(handler: NativeRtcMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  // ─── State ───────────────────────────────────────────────────────────────

  onStateChange(handler: NativeRtcConnectionStateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  getState(): RTCPeerConnectionState {
    return this.connection.connectionState;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    console.log(`[NativeRtcConnection][${this.label}] Disposing`);

    this.dataChannel?.close();
    this.dataChannel = undefined;

    this.connection.onconnectionstatechange = null;
    this.connection.onicecandidate = null;
    this.connection.ondatachannel = null;
    this.connection.close();

    this.stateHandlers.clear();
    this.messageHandlers.clear();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private attachDataChannelHandlers(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log(`[NativeRtcConnection][${this.label}] Data channel open`);
    };

    channel.onclose = () => {
      console.log(`[NativeRtcConnection][${this.label}] Data channel closed`);
    };

    channel.onerror = (event) => {
      console.error(
        `[NativeRtcConnection][${this.label}] Data channel error`,
        event,
      );
    };

    channel.onmessage = (event) => {
      const message = this.deserialize(event.data);
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    };
  }

  private deserialize(raw: unknown): RtcMessage {
    if (raw instanceof ArrayBuffer) {
      return raw;
    }
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as object;
      } catch {
        return raw;
      }
    }
    return String(raw);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`[NativeRtcConnection][${this.label}] Already disposed.`);
    }
  }
}
