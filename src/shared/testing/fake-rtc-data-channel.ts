import type {
  DataChannelState,
  RtcDataChannelPort,
} from "@/shared/infrastructure/webrtc/ports/rtc-data-channel-port";

/** One end of a fake data channel. Messages arrive in a microtask, in send order. */
export class FakeRtcDataChannel implements RtcDataChannelPort {
  readyState: DataChannelState = "connecting";
  peer?: FakeRtcDataChannel;
  private openHandler?: () => void;
  private messageHandler?: (data: string) => void;
  private closeHandler?: () => void;

  send(data: string): void {
    if (this.readyState !== "open") {
      throw new Error(`[FakeRtcDataChannel] Cannot send: ${this.readyState}`);
    }
    const peer = this.peer;
    queueMicrotask(() => peer?.receive(data));
  }

  /** Both ends are marked open before either open event fires, so an early send is not lost. */
  markOpen(): void {
    if (this.readyState === "connecting") this.readyState = "open";
  }

  fireOpen(): void {
    if (this.readyState === "open") this.openHandler?.();
  }

  /** Closes both ends. Close events fire asynchronously, like a browser. */
  close(): void {
    this.end();
    this.peer?.end();
  }

  /** This end is closed now; its close event fires in a microtask. */
  end(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    queueMicrotask(() => this.closeHandler?.());
  }

  /** This end's tab died: closed silently, no events. */
  drop(): void {
    this.readyState = "closed";
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(): void {}

  private receive(data: string): void {
    if (this.readyState === "open") this.messageHandler?.(data);
  }
}
