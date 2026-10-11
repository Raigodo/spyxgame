import {
  Countdown,
  logFailure,
  shortId,
  type Clock,
  type Logger,
  type SignalingConfig,
} from "@/shared/kernel";
import { candidateDelayMs, orderCandidates } from "./election-order";
import type { PeerRemover } from "./peer-remover";
import type { HostElectionPort } from "./ports/host-election-port";
import type { RoomMembershipPort } from "./ports/room-membership-port";
import type { RoomId, SignalingPeerId } from "./types";

export interface DeadHostElectionDeps {
  membership: RoomMembershipPort;
  election: HostElectionPort;
  remover: PeerRemover;
  clock: Clock;
  logger: Logger;
  config: SignalingConfig;
  roomId: RoomId;
  localPeerId: SignalingPeerId;
}

// The election that follows a suspected host death. One at a time:
//   suspect -> register candidacy -> collection window -> remove the host, confirm candidacy ->
//   confirm window -> order the confirmed candidates -> my turn -> atomic claim.
// Any host-document change cancels it (the owner calls cancel()), and a reconnect of the
// suspected host cancels it too, which is why the removal waits for the window to end.
export class DeadHostElection {
  private pendingDeadHostId?: SignalingPeerId;
  private readonly collectionWindow: Countdown;
  private readonly confirmWindow: Countdown;
  private readonly positionCountdown: Countdown;

  constructor(private readonly deps: DeadHostElectionDeps) {
    const { clock, logger } = deps;
    this.collectionWindow = new Countdown(
      clock,
      () =>
        void this.onCollectionWindowElapsed().catch(
          logFailure(logger, "election collection window")
        )
    );
    this.confirmWindow = new Countdown(
      clock,
      () => void this.onConfirmWindowElapsed().catch(logFailure(logger, "election confirm window"))
    );
    this.positionCountdown = new Countdown(
      clock,
      () => void this.onPositionCountdownElapsed().catch(logFailure(logger, "election turn"))
    );
  }

  private get log(): Logger {
    return this.deps.logger;
  }

  /** The host being waited on, if an election is in flight. */
  getSuspected(): SignalingPeerId | undefined {
    return this.pendingDeadHostId;
  }

  inspect(): Record<string, unknown> {
    return {
      suspectedDeadHostId: this.pendingDeadHostId,
      collectionWindowRunning: this.collectionWindow.isRunning(),
      confirmWindowRunning: this.confirmWindow.isRunning(),
      positionCountdownRunning: this.positionCountdown.isRunning(),
    };
  }

  // Idempotent for the same dead host id: a second report for a death already being handled
  // doesn't restart the collection window (that would keep pushing the election out forever).
  report(deadHostPeerId: SignalingPeerId): void {
    const { election, roomId, localPeerId, config } = this.deps;
    if (this.pendingDeadHostId === deadHostPeerId) return;

    this.cancel();
    this.pendingDeadHostId = deadHostPeerId;
    // No removal yet: the host is only suspected. It is removed when the collection window ends
    // without its link coming back (see onCollectionWindowElapsed).

    this.log.debug(`Registering candidacy for dead host=${shortId(deadHostPeerId)}`);
    election
      .registerCandidate(roomId, localPeerId, deadHostPeerId, "registered")
      .then(() => {
        if (this.pendingDeadHostId !== deadHostPeerId) return;
        this.log.debug(`Collecting candidates for ${config.candidateCollectionWindowMs}ms`);
        this.collectionWindow.start(config.candidateCollectionWindowMs);
      })
      .catch((error) => {
        this.log.warn(
          `Failed to register candidacy for dead host=${shortId(deadHostPeerId)}`,
          error
        );
      });
  }

  /** Cancels whatever election is currently in flight. */
  cancel(): void {
    this.collectionWindow.stop();
    this.confirmWindow.stop();
    this.positionCountdown.stop();
    if (this.pendingDeadHostId) this.log.debug("Election cancelled");
    this.pendingDeadHostId = undefined;
  }

  // The window ended and the host's link did not come back (a reconnect would have cancelled
  // this election): the removal is now justified. Then confirm our own candidacy.
  private async onCollectionWindowElapsed(): Promise<void> {
    const deadHostPeerId = this.pendingDeadHostId;
    if (!deadHostPeerId) return;
    const { election, remover, roomId, localPeerId, config } = this.deps;

    // Also clears the dead peer's inbox: nobody reads it again.
    void remover
      .remove(deadHostPeerId, "suspected-dead")
      .catch(logFailure(this.log, "remove suspected-dead host"));

    await election.registerCandidate(roomId, localPeerId, deadHostPeerId, "confirmed");
    if (this.pendingDeadHostId !== deadHostPeerId) return; // superseded meanwhile

    this.log.debug(`Candidacy confirmed, waiting ${config.candidateConfirmWindowMs}ms for others`);
    this.confirmWindow.start(config.candidateConfirmWindowMs);
  }

  // Only candidates that confirmed are alive right now; dead guests never confirm, so a chain of
  // departures after the host does not slow the election down.
  private async onConfirmWindowElapsed(): Promise<void> {
    const deadHostPeerId = this.pendingDeadHostId;
    if (!deadHostPeerId) return;

    const orderedCandidates = await this.getOrderedCandidates(deadHostPeerId);
    if (this.pendingDeadHostId !== deadHostPeerId) return; // superseded meanwhile

    this.log.debug(
      `Confirmed candidates for dead host=${shortId(deadHostPeerId)}: [${orderedCandidates.map(shortId).join(", ")}]`
    );

    const myPosition = orderedCandidates.indexOf(this.deps.localPeerId);
    if (myPosition === -1) {
      this.log.warn(`Local peer ${shortId(this.deps.localPeerId)} not in candidate list, skipping`);
      this.pendingDeadHostId = undefined;
      return;
    }

    const delay = candidateDelayMs(myPosition, this.deps.config.positionIntervalMs);
    this.log.debug(`Countdown started: position=${myPosition} delay=${delay}ms`);
    this.positionCountdown.start(delay);
  }

  // Position 0 fires at once; later positions only if everyone before them failed to take the
  // seat (a host-document change cancels this countdown). The claim is atomic: it succeeds only
  // while the host document still names the dead host.
  private async onPositionCountdownElapsed(): Promise<void> {
    const deadHostPeerId = this.pendingDeadHostId;
    if (!deadHostPeerId) return;
    const { election, roomId, localPeerId } = this.deps;

    const claimed = await election.claimHostIf(roomId, deadHostPeerId, localPeerId);
    this.log.debug(
      `Claim for dead host=${shortId(deadHostPeerId)}: ${claimed ? "won" : "lost (seat already taken)"}`
    );
    if (claimed) {
      election.clearAllCandidates(roomId).catch(logFailure(this.log, "clear stale candidates"));
    }
    if (this.pendingDeadHostId === deadHostPeerId) this.pendingDeadHostId = undefined;
  }

  private async getOrderedCandidates(deadHostPeerId: SignalingPeerId): Promise<SignalingPeerId[]> {
    const { election, membership, roomId, localPeerId } = this.deps;
    const [candidateIds, livePeers] = await Promise.all([
      election.listCandidates(roomId, deadHostPeerId, "confirmed"),
      membership.listPeers(roomId),
    ]);

    return orderCandidates({
      registered: candidateIds,
      livePeerIds: livePeers.map((p) => p.peerId),
      localPeerId,
      deadHostPeerId,
    });
  }
}
