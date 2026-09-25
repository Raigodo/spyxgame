// active-rtc-connection.ts

export type ActiveRtcConnectionState = "connected" | "disconnected" | "failed";

export class ActiveRtcConnection {
  readonly id: string = crypto.randomUUID();

  private state: ActiveRtcConnectionState = "connected";
  private readonly stateHandlers = new Set<(state: ActiveRtcConnectionState) => void>();
  private readonly messageHandlers = new Set<(message: string) => void>();

  constructor(
    private readonly connection: RTCPeerConnection,
    private readonly dataChannel: RTCDataChannel
  ) {
    console.log(`[ActiveRtcConnection][${this.id}] Created`);

    this.connection.onconnectionstatechange = () => {
      const native = this.connection.connectionState;
      console.log(`[ActiveRtcConnection][${this.id}] Connection state changed: ${native}`);

      if (native === "failed") {
        this.setState("failed");
      } else if (native === "disconnected" || native === "closed") {
        this.setState("disconnected");
      }
    };

    this.dataChannel.onmessage = (event: MessageEvent<string>) => {
      for (const handler of this.messageHandlers) {
        handler(event.data);
      }
    };

    this.dataChannel.onclose = () => {
      console.log(`[ActiveRtcConnection][${this.id}] Data channel closed`);
      this.setState("disconnected");
    };

    this.dataChannel.onerror = (event) => {
      console.warn(`[ActiveRtcConnection][${this.id}] Data channel error`, event);
    };
  }

  // ─── State ────────────────────────────────────────────────────────────────

  getState(): ActiveRtcConnectionState {
    return this.state;
  }

  onStateChange(handler: (state: ActiveRtcConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  // ─── Messaging ────────────────────────────────────────────────────────────

  send(message: string): void {
    if (this.state !== "connected") {
      throw new Error(`[ActiveRtcConnection][${this.id}] Cannot send — state is '${this.state}'`);
    }
    if (this.dataChannel.readyState !== "open") {
      throw new Error(
        `[ActiveRtcConnection][${this.id}] Cannot send — data channel is '${this.dataChannel.readyState}'`
      );
    }
    this.dataChannel.send(message);
  }

  onMessage(handler: (message: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    console.log(`[ActiveRtcConnection][${this.id}] Closed explicitly`);
    this.dataChannel.close();
    this.connection.close();
    this.setState("disconnected");
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private setState(state: ActiveRtcConnectionState): void {
    if (this.state === state) return;
    console.log(`[ActiveRtcConnection][${this.id}] State: ${this.state} → ${state}`);
    this.state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}
