import { Emitter, shortId, type Clock, type Logger, type SignalingConfig } from "@/shared/kernel";
import { DeadHostElection } from "./dead-host-election";
import { pickNextHost } from "./election-order";
import type { PeerRemover } from "./peer-remover";
import type { HostElectionPort, HostDocument } from "./ports/host-election-port";
import type { RoomMembershipPort } from "./ports/room-membership-port";
import type { RoomId, SignalingPeerId } from "./types";

type HostChangedHandler = (host: HostDocument | null) => void;

export interface HostElectionServiceDeps {
  membership: RoomMembershipPort;
  election: HostElectionPort;
  remover: PeerRemover;
  clock: Clock;
  logger: Logger;
  config: SignalingConfig;
  roomId: RoomId;
  localPeerId: SignalingPeerId;
}

// The host document: who it names, taking the seat (reclaim, handoff, first election), and
// forwarding changes. The election after a suspected death is DeadHostElection.
export class HostElectionService {
  private readonly hostChanged: Emitter<HostDocument | null>;
  private readonly dead: DeadHostElection;
  private unsubscribeFromHost?: () => void;

  constructor(
    private readonly deps: HostElectionServiceDeps,
    onError?: (error: unknown) => void
  ) {
    this.hostChanged = new Emitter<HostDocument | null>(onError);
    this.dead = new DeadHostElection(deps);
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

      this.hostChanged.emit(host);
    });
  }

  stop(): void {
    this.log.debug("Stopping");
    this.cancelPendingElection();
    this.unsubscribeFromHost?.();
    this.unsubscribeFromHost = undefined;
    this.hostChanged.clear();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  onHostChanged(handler: HostChangedHandler): () => void {
    return this.hostChanged.on(handler);
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
  // order), excluding `excludePeerId`. Used for a fresh room's first host and when the host
  // document was cleared. Not used after a suspected death: that goes through confirmed
  // candidates (DeadHostElection), because membership has no liveness.
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
  reportSuspectedDeath(deadHostPeerId: SignalingPeerId): void {
    this.dead.report(deadHostPeerId);
  }

  // Cancels whatever election is currently in flight.
  cancelPendingElection(): void {
    this.dead.cancel();
  }

  // Lets a caller check whether a specific peer is the one currently being waited on.
  getSuspectedDeadHostId(): SignalingPeerId | undefined {
    return this.dead.getSuspected();
  }

  inspect(): Record<string, unknown> {
    return this.dead.inspect();
  }
}
