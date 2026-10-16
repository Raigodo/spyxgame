import type { RtcDataChannelPort } from "./ports/rtc-data-channel-port";
import type { RtcPeerConnectionPort } from "./ports/rtc-peer-connection-port";
import {
  Countdown,
  Emitter,
  shortId,
  type Clock,
  type IdGenerator,
  type Logger,
} from "@/shared/kernel";

export type ActiveRtcConnectionState = "connected" | "disconnected" | "failed";

export interface ActiveRtcConnectionDeps {
  connection: RtcPeerConnectionPort;
  channel: RtcDataChannelPort;
  ids: IdGenerator;
  logger: Logger;
  clock: Clock;
  disconnectGraceMs: number;
}

export class ActiveRtcConnection {
  readonly id: string;

  private state: ActiveRtcConnectionState = "connected";
  private readonly stateChanged = new Emitter<ActiveRtcConnectionState>();
  private readonly messageReceived = new Emitter<string>();
  private readonly log: Logger;
  private readonly graceTimer: Countdown;

  constructor(private readonly deps: ActiveRtcConnectionDeps) {
    this.id = deps.ids.next();
    this.log = deps.logger.child(shortId(this.id));
    this.log.debug("Created");

    this.graceTimer = new Countdown(deps.clock, () => this.setState("disconnected"));

    deps.connection.onConnectionState((native) => {
      this.log.debug(`Connection state changed: ${native}`);
      if (native === "failed") {
        this.graceTimer.stop();
        this.setState("failed");
      } else if (native === "closed") {
        this.graceTimer.stop();
        this.setState("disconnected");
      } else if (native === "disconnected") {
        this.graceTimer.start(deps.disconnectGraceMs);
      } else if (native === "connected") {
        this.graceTimer.stop();
      }
    });

    deps.channel.onMessage((message) => this.messageReceived.emit(message));

    deps.channel.onClose(() => {
      this.log.debug("Data channel closed");
      this.setState("disconnected");
    });

    deps.channel.onError((error) => this.log.warn("Data channel error", error));
  }

  // ─── State ────────────────────────────────────────────────────────────────

  getState(): ActiveRtcConnectionState {
    return this.state;
  }

  onStateChange(handler: (state: ActiveRtcConnectionState) => void): () => void {
    return this.stateChanged.on(handler);
  }

  // ─── Messaging ────────────────────────────────────────────────────────────

  send(message: string): void {
    if (this.state !== "connected") {
      throw new Error(`[ActiveRtcConnection] Cannot send: state is '${this.state}'`);
    }
    const { readyState } = this.deps.channel;
    if (readyState !== "open") {
      throw new Error(`[ActiveRtcConnection] Cannot send: data channel is '${readyState}'`);
    }
    this.deps.channel.send(message);
  }

  onMessage(handler: (message: string) => void): () => void {
    return this.messageReceived.on(handler);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.log.debug("Closed explicitly");
    this.graceTimer.stop();
    this.deps.channel.close();
    this.deps.connection.close();
    this.setState("disconnected");
  }

  private setState(state: ActiveRtcConnectionState): void {
    if (this.state === state) return;
    this.log.debug(`State: ${this.state} → ${state}`);
    this.state = state;
    this.stateChanged.emit(state);
  }
}
