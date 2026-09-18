import { SignalingPeerId } from "../signaling";
import { NativeRtcConnection } from "./native-rtc-connection";
import { RtcConnectionFactory } from "./rtc-connection-factory";
import { RtcConnectionMonitor } from "./rtc-connection-monitor";
import type { RtcMessage, RtcPeerId, RtcPeerStatus } from "./types";

interface RtcPeerConnectionCallbacks {
  onStatusChanged: (status: RtcPeerStatus) => void;
  onMessage: (message: RtcMessage) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onDead: () => void;
}

export class RtcPeerConnection {
  private nativeConnection?: NativeRtcConnection;
  private monitor?: RtcConnectionMonitor;
  private unsubscribeFromIce?: () => void;
  private unsubscribeFromMessages?: () => void;
  private disposed = false;

  readonly signalingPeerId: SignalingPeerId;
  private _rtcPeerId: RtcPeerId;
  private _status: RtcPeerStatus = "connecting";

  constructor(
    signalingPeerId: SignalingPeerId,
    private readonly factory: RtcConnectionFactory,
    private readonly callbacks: RtcPeerConnectionCallbacks,
  ) {
    this.signalingPeerId = signalingPeerId;
    this._rtcPeerId = crypto.randomUUID();
  }

  get rtcPeerId(): RtcPeerId {
    return this._rtcPeerId;
  }

  get status(): RtcPeerStatus {
    return this._status;
  }

  // ─── Host flow ───────────────────────────────────────────────────────────

  async initAsHost(): Promise<RTCSessionDescriptionInit> {
    console.log(
      `[RtcPeerConnection][${this.signalingPeerId}] Initializing as host, rtcPeerId=${this._rtcPeerId}`,
    );
    const native = this.createNativeConnection();
    return native.createOfferAsHost();
  }

  // ─── Guest flow ──────────────────────────────────────────────────────────

  async receiveOffer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    console.log(
      `[RtcPeerConnection][${this.signalingPeerId}] Receiving offer, rtcPeerId=${this._rtcPeerId}`,
    );
    const native = this.createNativeConnection();
    return native.receiveOfferAsGuest(offer);
  }

  async receiveAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    console.log(
      `[RtcPeerConnection][${this.signalingPeerId}] Receiving answer`,
    );
    this.assertNativeConnection().receiveAnswer(answer);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.assertNativeConnection().addIceCandidate(candidate);
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  send(message: RtcMessage): void {
    this.assertNativeConnection().send(message);
  }

  // ─── Reconnection ────────────────────────────────────────────────────────

  async reconnectAsHost(): Promise<RTCSessionDescriptionInit> {
    console.log(
      `[RtcPeerConnection][${this.signalingPeerId}] Reconnecting as host`,
    );
    this.disposeNativeConnection();
    this._rtcPeerId = crypto.randomUUID();
    this.setStatus("reconnecting");
    return this.initAsHost();
  }

  async reconnectAsGuest(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    console.log(
      `[RtcPeerConnection][${this.signalingPeerId}] Reconnecting as guest`,
    );
    this.disposeNativeConnection();
    this._rtcPeerId = crypto.randomUUID();
    this.setStatus("reconnecting");
    return this.receiveOffer(offer);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    console.log(`[RtcPeerConnection][${this.signalingPeerId}] Disposing`);
    this.disposeNativeConnection();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private createNativeConnection(): NativeRtcConnection {
    const label = `${this.signalingPeerId}/${this._rtcPeerId}`;
    const native = new NativeRtcConnection(label, this.factory.create());

    this.nativeConnection = native;

    this.unsubscribeFromIce = native.onIceCandidate((candidate) => {
      this.callbacks.onIceCandidate(candidate);
    });

    this.unsubscribeFromMessages = native.onMessage((message) => {
      this.callbacks.onMessage(message);
    });

    native.onStateChange((state) => {
      if (state === "connected") {
        this.setStatus("active");
      }
    });

    this.monitor = new RtcConnectionMonitor(label, native, () => {
      console.warn(
        `[RtcPeerConnection][${this.signalingPeerId}] Connection declared dead`,
      );
      this.setStatus("dead");
      this.callbacks.onDead();
    });

    this.monitor.start();

    return native;
  }

  private disposeNativeConnection(): void {
    this.unsubscribeFromIce?.();
    this.unsubscribeFromIce = undefined;

    this.unsubscribeFromMessages?.();
    this.unsubscribeFromMessages = undefined;

    this.monitor?.dispose();
    this.monitor = undefined;

    this.nativeConnection?.dispose();
    this.nativeConnection = undefined;
  }

  private setStatus(status: RtcPeerStatus): void {
    if (this._status === status) {
      return;
    }
    console.log(
      `[RtcPeerConnection][${this.signalingPeerId}] Status: ${this._status} → ${status}`,
    );
    this._status = status;
    this.callbacks.onStatusChanged(status);
  }

  private assertNativeConnection(): NativeRtcConnection {
    if (!this.nativeConnection) {
      throw new Error(
        `[RtcPeerConnection][${this.signalingPeerId}] No active native connection.`,
      );
    }
    return this.nativeConnection;
  }
}
