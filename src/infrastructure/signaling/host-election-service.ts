import { Countdown } from "./countdown";
import type {
  HostDocument,
  HostElectionGateway,
} from "./host-election-gateway";
import type { RoomMembershipGateway } from "./room-membership-gateway";
import type { RoomId, SignalingPeerId } from "./types";

const CANDIDATE_COLLECTION_WINDOW_MS = 5_000;
const POSITION_INTERVAL_MS = 5_000;

type HostChangedHandler = (host: HostDocument | null) => void;

export class HostElectionService {
  private readonly hostChangedHandlers = new Set<HostChangedHandler>();
  private unsubscribeFromHost?: () => void;

  private readonly collectionWindow = new Countdown(
    () => void this.onCollectionWindowElapsed(),
  );
  private readonly positionCountdown = new Countdown(
    () => void this.onPositionCountdownElapsed(),
  );
  private pendingDeadHostId?: SignalingPeerId;

  public constructor(
    private readonly membershipGateway: RoomMembershipGateway,
    private readonly electionGateway: HostElectionGateway,
    private readonly roomId: RoomId,
    private readonly localPeerId: SignalingPeerId,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    console.log("[HostElectionService] Starting");
    this.unsubscribeFromHost = this.electionGateway.subscribeToHost(
      this.roomId,
      (host) => {
        console.log(
          `[HostElectionService] Host document changed: ${host ? short(host.signalingPeerId) : "null"}`,
        );

        // Any host-document change — elected or cleared — means whatever
        // election was running has concluded. Cancelling here, inside the
        // subscription itself, means nothing outside this class has to
        // remember to do it (that was the source of one of the earlier bugs).
        this.cancelPendingElection();

        for (const handler of this.hostChangedHandlers) {
          handler(host);
        }
      },
    );
  }

  stop(): void {
    console.log("[HostElectionService] Stopping");
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
    return this.electionGateway.getHost(this.roomId);
  }

  async clearHost(): Promise<void> {
    console.log("[HostElectionService] Clearing host document");
    await this.electionGateway.clearHost(this.roomId);
  }

  async removeOwnCandidacy(): Promise<void> {
    await this.electionGateway.removeCandidate(this.roomId, this.localPeerId);
  }

  // Elects a host from the currently live signaling peers, deterministically
  // (lexicographic order), excluding `excludePeerId`. Used both for a fresh
  // room's first host and for re-election after a confirmed death.
  async electNextHost(
    excludePeerId?: SignalingPeerId,
  ): Promise<SignalingPeerId | null> {
    console.log("[HostElectionService] Electing next host");

    const livePeers = await this.membershipGateway.listPeers(this.roomId);
    const candidateIds = Array.from(
      new Set([this.localPeerId, ...livePeers.map((p) => p.peerId)]),
    )
      .filter((id) => id !== excludePeerId)
      .sort();

    if (candidateIds.length === 0) {
      console.warn("[HostElectionService] No peers available for election");
      return null;
    }

    const nextPeerId = candidateIds[0];
    console.log(
      `[HostElectionService] Writing next host: ${short(nextPeerId)}`,
    );
    await this.electionGateway.writeHost(this.roomId, nextPeerId);
    return nextPeerId;
  }

  // Called by the RTC layer whenever it suspects `deadHostPeerId` is no
  // longer responding. Idempotent for the same dead host id — a second
  // report for a death already being handled doesn't restart the collection
  // window (that would keep pushing the election out forever).
  reportSuspectedDeath(deadHostPeerId: SignalingPeerId): void {
    if (this.pendingDeadHostId === deadHostPeerId) return;

    this.cancelPendingElection();
    this.pendingDeadHostId = deadHostPeerId;

    // Nothing else ever prunes a dead peer's signaling doc when it was the
    // host — guests only wait for an offer from a dead host, they never
    // message it, so the ack-timeout cleanup path never triggers for it.
    // Left alone, `electNextHost`'s "live peers" query keeps including
    // corpses forever; if the host and the next-in-line both die close
    // together, election alternates between the two dead ids indefinitely.
    // Once we've locally confirmed unresponsiveness, treat it as ground
    // truth and remove it here.
    console.log(
      `[HostElectionService] Removing confirmed-dead peer from room: ${short(deadHostPeerId)}`,
    );
    void this.membershipGateway.removePeer(this.roomId, deadHostPeerId);

    console.log(
      `[HostElectionService] Registering candidacy for dead host=${short(deadHostPeerId)}`,
    );
    this.electionGateway
      .registerCandidate(this.roomId, this.localPeerId, deadHostPeerId)
      .then(() => {
        if (this.pendingDeadHostId !== deadHostPeerId) return;
        console.log(
          `[HostElectionService] Collecting candidates for ${CANDIDATE_COLLECTION_WINDOW_MS}ms`,
        );
        this.collectionWindow.start(CANDIDATE_COLLECTION_WINDOW_MS);
      })
      .catch((error) => {
        console.warn(
          `[HostElectionService] Failed to register candidacy for dead host=${short(deadHostPeerId)}`,
          error,
        );
      });
  }

  // Cancels whatever election is currently in flight.
  cancelPendingElection(): void {
    this.collectionWindow.stop();
    this.positionCountdown.stop();
    if (this.pendingDeadHostId) {
      console.log("[HostElectionService] Election cancelled");
    }
    this.pendingDeadHostId = undefined;
  }

  // Lets a caller check whether a specific peer is the one currently being
  // waited on, without exposing full internal state.
  getSuspectedDeadHostId(): SignalingPeerId | undefined {
    return this.pendingDeadHostId;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async onCollectionWindowElapsed(): Promise<void> {
    const deadHostPeerId = this.pendingDeadHostId;
    if (!deadHostPeerId) return;

    const orderedCandidates = await this.getOrderedCandidates(deadHostPeerId);
    if (this.pendingDeadHostId !== deadHostPeerId) return; // superseded meanwhile

    console.log(
      `[HostElectionService] Candidates for dead host=${short(deadHostPeerId)}: [${orderedCandidates.map(short).join(", ")}]`,
    );

    const myPosition = orderedCandidates.indexOf(this.localPeerId);
    if (myPosition === -1) {
      console.warn(
        `[HostElectionService] Local peer ${short(this.localPeerId)} not in candidate list — skipping`,
      );
      this.pendingDeadHostId = undefined;
      return;
    }

    const delay = myPosition * POSITION_INTERVAL_MS;
    console.log(
      `[HostElectionService] Countdown started — position=${myPosition} delay=${delay}ms`,
    );
    this.positionCountdown.start(delay);
  }

  private async onPositionCountdownElapsed(): Promise<void> {
    const deadHostPeerId = this.pendingDeadHostId;
    if (!deadHostPeerId) return;

    console.log("[HostElectionService] Countdown fired — electing next host");
    await this.electNextHost(deadHostPeerId);
    if (this.pendingDeadHostId === deadHostPeerId) {
      this.pendingDeadHostId = undefined;
    }
  }

  private async getOrderedCandidates(
    deadHostPeerId: SignalingPeerId,
  ): Promise<SignalingPeerId[]> {
    const [candidateIds, livePeers] = await Promise.all([
      this.electionGateway.listCandidates(this.roomId, deadHostPeerId),
      this.membershipGateway.listPeers(this.roomId),
    ]);

    const liveIds = new Set(livePeers.map((p) => p.peerId));
    liveIds.add(this.localPeerId);

    return candidateIds
      .filter((id) => id !== deadHostPeerId && liveIds.has(id))
      .sort();
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
