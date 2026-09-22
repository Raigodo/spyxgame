import { Countdown } from "./countdown";
import type { SignalingMailbox } from "./signaling-mailbox";
import type { MessageId, SignalingPeerId } from "./types";

const ACK_TIMEOUT_MS = 15_000;

export type AckTimeoutStrategy = "remove" | "do-nothing";

export class PendingSignalAckTracker {
  private readonly countdowns = new Map<SignalingPeerId, Countdown>();
  private readonly pending = new Map<
    SignalingPeerId,
    { messageId: MessageId; strategy: AckTimeoutStrategy }
  >();

  public constructor(
    private readonly mailbox: SignalingMailbox,
    private readonly onTimedOut: (peerId: SignalingPeerId) => void,
  ) {}

  // Tracks a newly-sent message for `peerId`, resetting any existing
  // countdown. Only the most recently sent message per peer is checked when
  // the timer fires — always reads the current entry from `pending` at
  // fire-time, so a reused countdown never checks a stale message id.
  track(
    peerId: SignalingPeerId,
    messageId: MessageId,
    strategy: AckTimeoutStrategy,
  ): void {
    this.pending.set(peerId, { messageId, strategy });

    let countdown = this.countdowns.get(peerId);
    if (!countdown) {
      countdown = new Countdown(() => void this.handleTimeout(peerId));
      this.countdowns.set(peerId, countdown);
    }
    countdown.start(ACK_TIMEOUT_MS);
  }

  // Call when any signal arrives from this peer — treated as an ack for
  // whatever we most recently sent it.
  acknowledge(peerId: SignalingPeerId): void {
    this.countdowns.get(peerId)?.stop();
    this.countdowns.delete(peerId);
    this.pending.delete(peerId);
  }

  // Call when a peer leaves — stops its timer without treating it as an ack.
  forget(peerId: SignalingPeerId): void {
    this.acknowledge(peerId);
  }

  private async handleTimeout(peerId: SignalingPeerId): Promise<void> {
    this.countdowns.delete(peerId);
    const pending = this.pending.get(peerId);
    this.pending.delete(peerId);
    if (!pending || pending.strategy !== "remove") return;

    const stillPending = await this.mailbox.isMessageStillPending({
      toPeerId: peerId,
      id: pending.messageId,
    });
    if (stillPending) {
      this.onTimedOut(peerId);
    }
  }
}
