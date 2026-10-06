import { Countdown, shortId, type Clock, type Logger, type SignalingConfig } from "@/shared/kernel";
import type { HostElectionPort, HostDocument } from "./ports/host-election-port";
import type { RoomMembershipPort } from "./ports/room-membership-port";
import type { SignalInboxPort } from "./ports/signal-inbox-port";
import type { RoomId, SignalingPeerId } from "./types";
import { candidateDelayMs, orderCandidates, pickNextHost } from "./election-order";

type HostChangedHandler = (host: HostDocument | null) => void;

export interface HostElectionServiceDeps {
  membership: RoomMembershipPort;
  election: HostElectionPort;
  messages: SignalInboxPort;
  clock: Clock;
  logger: Logger;
  config: SignalingConfig;
  roomId: RoomId;
  localPeerId: SignalingPeerId;
}

export class HostElectionService {
  private readonly hostChangedHandlers = new Set<HostChangedHandler>();
  private unsubscribeFromHost?: () => void;

  private readonly collectionWindow: Countdown;
  private readonly positionCountdown: Countdown;
  private pendingDeadHostId?: SignalingPeerId;

  constructor(private readonly deps: HostElectionServiceDeps) {
    this.collectionWindow = new Countdown(deps.clock, () => void this.onCollectionWindowElapsed());
    this.positionCountdown = new Countdown(
      deps.clock,
      () => void this.onPositionCountdownElapsed()
    );
  }

  private get log(): Logger {
    return this.deps.logger;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.log.debug("Starting");
    this.unsubscribeFromHost = this.deps.election.subscribeToHost(this.deps.roomId, (host) => {
      this.log.debug(`Host document changed: ${host ? shortId(host.signalingPeerId) : "null"}`);

      // Any host-document change (elected or cleared) means whatever election was running has
      // concluded. Cancelling here, inside the subscription itself, means nothing outside this
      // class has to remember to do it (that was the source of one of the earlier bugs).
      this.cancelPendingElection();

      for (const handler of this.hostChangedHandlers) handler(host);
    });
  }

  stop(): void {
    this.log.debug("Stopping");
    this.cancelPendingElection();
    this.unsubscribeFromHost?.();
    this.unsubscribeFromHost = undefined;
    this.hostChangedHandlers.clear();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  onHostChanged(handler: HostChangedHandler): () => void {
    this.hostChangedHandlers.add(handler);
    return () => this.hostChangedHandlers.delete(handler);
  }

  async currentHost(): Promise<HostDocument | null> {
    return this.deps.election.getHost(this.deps.roomId);
  }

  async clearHost(): Promise<void> {
    this.log.debug("Clearing host document");
    await this.deps.election.clearHost(this.deps.roomId);
  }

  // A refreshed host taking its seat back. `formerPeerId` is its own previous incarnation.
  //  - "former-present": that peer is still in the room (the guests have not noticed it died yet,
  //    or it is a live duplicate tab). Do not claim.
  //  - "host-changed": the host document names someone else now. Too late.
  async claimHost(
    formerPeerId: SignalingPeerId
  ): Promise<"claimed" | "former-present" | "host-changed"> {
    const { membership, election, roomId, localPeerId } = this.deps;
    if (await membership.peerExists(roomId, formerPeerId)) return "former-present";
    const claimed = await election.claimHostIf(roomId, formerPeerId, localPeerId);
    if (!claimed) return "host-changed";
    this.cancelPendingElection(); // our own pending election, if the watch-for-offer timer got there first
    return "claimed";
  }

  // Host only. Atomically gives the host document to `targetPeerId`, only while it still names us.
  async transferHost(targetPeerId: SignalingPeerId): Promise<boolean> {
    const { election, roomId, localPeerId } = this.deps;
    if (targetPeerId === localPeerId) return false;
    const transferred = await election.claimHostIf(roomId, localPeerId, targetPeerId);
    if (transferred) this.cancelPendingElection();
    return transferred;
  }

  async removeOwnCandidacy(): Promise<void> {
    await this.deps.election.removeCandidate(this.deps.roomId, this.deps.localPeerId);
  }

  // Elects a host from the currently live signaling peers, deterministically (lexicographic
  // order), excluding `excludePeerId`. Used both for a fresh room's first host and for
  // re-election after a confirmed death.
  async electNextHost(excludePeerId?: SignalingPeerId): Promise<SignalingPeerId | null> {
    const { membership, election, roomId, localPeerId } = this.deps;
    this.log.debug("Electing next host");

    const livePeers = await membership.listPeers(roomId);
    const nextPeerId = pickNextHost(
      livePeers.map((p) => p.peerId),
      localPeerId,
      excludePeerId
    );
    if (nextPeerId === undefined) {
      this.log.warn("No peers available for election");
      return null;
    }

    this.log.debug(`Writing next host: ${shortId(nextPeerId)}`);
    await election.writeHost(roomId, nextPeerId);

    // Best-effort: every registered candidacy, for this dead host or any earlier one, is now
    // moot. Candidate lookups are scoped to one dead-host id, so nothing reads a stale entry.
    election
      .clearAllCandidates(roomId)
      .catch((error) => this.log.warn("Failed to clear stale candidates", error));

    return nextPeerId;
  }

  // Called by the RTC layer whenever it suspects `deadHostPeerId` is no longer responding.
  // Idempotent for the same dead host id: a second report for a death already being handled
  // doesn't restart the collection window (that would keep pushing the election out forever).
  reportSuspectedDeath(deadHostPeerId: SignalingPeerId): void {
    const { membership, election, messages, roomId, localPeerId, config } = this.deps;
    if (this.pendingDeadHostId === deadHostPeerId) return;

    this.cancelPendingElection();
    this.pendingDeadHostId = deadHostPeerId;

    this.log.debug(`Removing confirmed-dead peer from room: ${shortId(deadHostPeerId)}`);
    membership
      .removePeer(roomId, deadHostPeerId)
      .catch((error) => this.log.warn("Failed to remove dead peer", error));

    // Best-effort: nobody reads this peer's inbox again, so anything mid-flight to it would
    // otherwise sit there unread indefinitely.
    messages
      .clearInbox(roomId, deadHostPeerId)
      .catch((error) => this.log.warn("Failed to clear dead peer's inbox", error));

    this.log.debug(`Registering candidacy for dead host=${shortId(deadHostPeerId)}`);
    election
      .registerCandidate(roomId, localPeerId, deadHostPeerId)
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

  // Cancels whatever election is currently in flight.
  cancelPendingElection(): void {
    this.collectionWindow.stop();
    this.positionCountdown.stop();
    if (this.pendingDeadHostId) this.log.debug("Election cancelled");
    this.pendingDeadHostId = undefined;
  }

  // Lets a caller check whether a specific peer is the one currently being waited on.
  getSuspectedDeadHostId(): SignalingPeerId | undefined {
    return this.pendingDeadHostId;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async onCollectionWindowElapsed(): Promise<void> {
    const deadHostPeerId = this.pendingDeadHostId;
    if (!deadHostPeerId) return;

    const orderedCandidates = await this.getOrderedCandidates(deadHostPeerId);
    if (this.pendingDeadHostId !== deadHostPeerId) return; // superseded meanwhile

    this.log.debug(
      `Candidates for dead host=${shortId(deadHostPeerId)}: [${orderedCandidates.map(shortId).join(", ")}]`
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

  private async onPositionCountdownElapsed(): Promise<void> {
    const deadHostPeerId = this.pendingDeadHostId;
    if (!deadHostPeerId) return;

    this.log.debug("Countdown fired, electing next host");
    await this.electNextHost(deadHostPeerId);
    if (this.pendingDeadHostId === deadHostPeerId) this.pendingDeadHostId = undefined;
  }

  private async getOrderedCandidates(deadHostPeerId: SignalingPeerId): Promise<SignalingPeerId[]> {
    const { election, membership, roomId, localPeerId } = this.deps;
    const [candidateIds, livePeers] = await Promise.all([
      election.listCandidates(roomId, deadHostPeerId),
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
