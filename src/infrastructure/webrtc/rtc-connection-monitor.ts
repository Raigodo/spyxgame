import { NativeRtcConnection } from "./native-rtc-connection";

const DISCONNECTED_TIMEOUT_MS = 5_000;

export class RtcConnectionMonitor {
  private disconnectedTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private unsubscribeFromState?: () => void;

  constructor(
    private readonly label: string,
    private readonly connection: NativeRtcConnection,
    private readonly onDead: () => void,
  ) {}

  start(): void {
    console.log(`[RtcConnectionMonitor][${this.label}] Monitoring started`);

    this.unsubscribeFromState = this.connection.onStateChange((state) => {
      this.handleStateChange(state);
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    console.log(`[RtcConnectionMonitor][${this.label}] Disposed`);
    this.clearDisconnectedTimer();
    this.unsubscribeFromState?.();
  }

  private handleStateChange(state: RTCPeerConnectionState): void {
    console.log(
      `[RtcConnectionMonitor][${this.label}] Handling state: ${state}`,
    );

    switch (state) {
      case "connected":
        console.log(
          `[RtcConnectionMonitor][${this.label}] Connected — clearing any disconnected timer`,
        );
        this.clearDisconnectedTimer();
        break;

      case "disconnected":
        console.warn(
          `[RtcConnectionMonitor][${this.label}] Disconnected — starting ${DISCONNECTED_TIMEOUT_MS}ms timer`,
        );
        this.startDisconnectedTimer();
        break;

      case "failed":
        console.warn(
          `[RtcConnectionMonitor][${this.label}] Failed — declaring dead immediately`,
        );
        this.clearDisconnectedTimer();
        this.declareDead();
        break;

      case "closed":
        console.log(`[RtcConnectionMonitor][${this.label}] Closed`);
        this.clearDisconnectedTimer();
        break;
    }
  }

  private startDisconnectedTimer(): void {
    this.clearDisconnectedTimer();
    this.disconnectedTimer = setTimeout(() => {
      console.warn(
        `[RtcConnectionMonitor][${this.label}] Disconnected timer expired — declaring dead`,
      );
      this.declareDead();
    }, DISCONNECTED_TIMEOUT_MS);
  }

  private clearDisconnectedTimer(): void {
    if (this.disconnectedTimer) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = undefined;
    }
  }

  private declareDead(): void {
    if (!this.disposed) {
      this.onDead();
    }
  }
}
