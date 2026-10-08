import {
  Countdown,
  logFailure,
  type Clock,
  type Logger,
  type SignalingConfig,
} from "@/shared/kernel";
import type { SignalingMailbox } from "./signaling-mailbox";
import type { MessageId, SignalingPeerId } from "./types";

export type AckTimeoutStrategy = "remove" | "do-nothing";

export interface PendingSignalAckTrackerDeps {
  mailbox: SignalingMailbox;
  clock: Clock;
  logger: Logger;
  config: SignalingConfig;
  onTimedOut: (peerId: SignalingPeerId) => void;
}

export class PendingSignalAckTracker {
  private readonly countdowns = new Map<SignalingPeerId, Countdown>();
  private readonly pending = new Map<
    SignalingPeerId,
    { messageId: MessageId; strategy: AckTimeoutStrategy }
  >();

  constructor(private readonly deps: PendingSignalAckTrackerDeps) {}

  // Tracks a newly-sent message for `peerId`, resetting any existing countdown. Only the most
  // recently sent message per peer is checked when the timer fires: the current entry is read
  // from `pending` at fire time, so a reused countdown never checks a stale message id.
  track(peerId: SignalingPeerId, messageId: MessageId, strategy: AckTimeoutStrategy): void {
    this.pending.set(peerId, { messageId, strategy });

    let countdown = this.countdowns.get(peerId);
    if (!countdown) {
      countdown = new Countdown(
        this.deps.clock,
        () =>
          void this.handleTimeout(peerId).catch(logFailure(this.deps.logger, "ack timeout check"))
      );
      this.countdowns.set(peerId, countdown);
    }
    countdown.start(this.deps.config.ackTimeoutMs);
  }

  // Any signal arriving from this peer counts as an ack for whatever we sent it last.
  acknowledge(peerId: SignalingPeerId): void {
    this.countdowns.get(peerId)?.stop();
    this.countdowns.delete(peerId);
    this.pending.delete(peerId);
  }

  // A peer left: stop its timer without treating it as an ack.
  forget(peerId: SignalingPeerId): void {
    this.acknowledge(peerId);
  }

  private async handleTimeout(peerId: SignalingPeerId): Promise<void> {
    this.countdowns.delete(peerId);
    const pending = this.pending.get(peerId);
    this.pending.delete(peerId);
    if (!pending || pending.strategy !== "remove") return;

    const stillPending = await this.deps.mailbox.isMessageStillPending({
      toPeerId: peerId,
      id: pending.messageId,
    });
    if (stillPending) this.deps.onTimedOut(peerId);
  }
}
