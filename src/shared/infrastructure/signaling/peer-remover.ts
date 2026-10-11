import { logFailure, shortId, type Logger } from "@/shared/kernel";
import type { RoomMembershipPort } from "./ports/room-membership-port";
import type { SignalInboxPort } from "./ports/signal-inbox-port";
import type { RoomId, SignalingPeerId } from "./types";

/** Why a peer is being deleted from membership. Every deletion of another peer has one. */
export type RemovalReason = "suspected-dead" | "ack-timeout" | "host-removed" | "reclaim";

/** Reasons a caller outside the election/ack machinery may give. */
export type ManualRemovalReason = Extract<RemovalReason, "host-removed" | "reclaim">;

/** After an ack timeout the peer's inbox is left alone (saves a read; it is never read again). */
export function shouldClearInbox(reason: RemovalReason): boolean {
  return reason !== "ack-timeout";
}

export interface PeerRemoverDeps {
  membership: RoomMembershipPort;
  messages: SignalInboxPort;
  logger: Logger;
  roomId: RoomId;
}

// The only place another peer is deleted from membership. Destructive: callers must have a
// reason. Rules about *whether* to delete (confirmation) belong here too, not at the call sites.
export class PeerRemover {
  private readonly counts: Record<RemovalReason, number> = {
    "suspected-dead": 0,
    "ack-timeout": 0,
    "host-removed": 0,
    reclaim: 0,
  };

  constructor(private readonly deps: PeerRemoverDeps) {}

  /**
   * Deletes the membership doc and, depending on the reason, the peer's signal inbox. Rejects if
   * the membership delete fails; an inbox failure is only logged.
   */
  async remove(peerId: SignalingPeerId, reason: RemovalReason): Promise<void> {
    const { membership, messages, logger, roomId } = this.deps;
    this.counts[reason]++;
    logger.debug(`Removing peer=${shortId(peerId)} from membership (${reason})`);

    const inbox = shouldClearInbox(reason)
      ? messages
          .clearInbox(roomId, peerId)
          .catch(logFailure(logger, `clear inbox of removed peer (${reason})`))
      : Promise.resolve();

    try {
      await membership.removePeer(roomId, peerId);
    } finally {
      await inbox;
    }
  }

  inspect(): Record<string, unknown> {
    return { ...this.counts };
  }
}
