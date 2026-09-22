import type { FirestoreHostService } from "@infrastructure/signaling/firestore-host-service";
import type { RtcPeerRegistry } from "./rtc-peer-registry";
import type { SignalingPeerId } from "@infrastructure/signaling";

const CANDIDATE_COLLECTION_WINDOW_MS = 5_000;
const POSITION_INTERVAL_MS = 5_000;

export class RtcHostElectionCoordinator {
  private collectionTimer?: ReturnType<typeof setTimeout>;
  private collectionResolve?: () => void;
  private electionCountdown?: ReturnType<typeof setTimeout>;
  private unsubscribeFromRegistry?: () => void;

  // Which dead host the currently-running election (if any) is for.
  private currentElectionDeadHostId?: SignalingPeerId;

  // Bumped on every cancellation — in-flight async election work checks
  // this after each await and bails out if it's stale, instead of leaving
  // orphaned timers/promises running after a cancel.
  private electionToken = 0;

  constructor(
    private readonly getHostService: () => FirestoreHostService,
    private readonly registry: RtcPeerRegistry,
  ) {}

  start(): void {
    this.unsubscribeFromRegistry = this.registry.onAnyStatusChanged(
      (status) => {
        if (status === "active") {
          console.log(
            "[RtcHostElectionCoordinator] Peer became active — cancelling election",
          );
          this.cancelElection();
        }
      },
    );
  }

  stop(): void {
    this.cancelElection();
    this.unsubscribeFromRegistry?.();
    this.unsubscribeFromRegistry = undefined;
  }

  // Called whenever a peer suspects a host is dead. Idempotent for the same
  // dead host id — a second report for a death already being handled must
  // not restart the collection window, or the window would keep sliding
  // forward every time another peer notices the same thing.
  startCountdown(deadHostPeerId: SignalingPeerId): void {
    if (this.currentElectionDeadHostId === deadHostPeerId) {
      return;
    }

    this.cancelElection();
    this.currentElectionDeadHostId = deadHostPeerId;
    const myToken = ++this.electionToken;

    void this.runElection(deadHostPeerId, myToken);
  }

  // Cancels whatever election is currently in flight. Must be called
  // whenever the host document changes to ANY value (elected or cleared) —
  // not just when it's cleared — otherwise a peer whose countdown is still
  // running will fire later and overwrite a host that was already elected.
  cancelCountdown(): void {
    this.cancelElection();
  }

  private cancelElection(): void {
    if (this.collectionTimer) {
      clearTimeout(this.collectionTimer);
      this.collectionTimer = undefined;
    }
    this.collectionResolve?.();
    this.collectionResolve = undefined;

    if (this.electionCountdown) {
      clearTimeout(this.electionCountdown);
      this.electionCountdown = undefined;
    }

    if (this.currentElectionDeadHostId) {
      console.log("[RtcHostElectionCoordinator] Election cancelled");
    }
    this.currentElectionDeadHostId = undefined;
    this.electionToken++;
  }

  private async runElection(
    deadHostPeerId: SignalingPeerId,
    token: number,
  ): Promise<void> {
    const hostService = this.getHostService();
    const localPeerId = hostService.localPeerId;

    await hostService.registerAsElectionCandidate(deadHostPeerId);
    if (token !== this.electionToken) return;

    console.log(
      `[RtcHostElectionCoordinator] Collecting candidates for ${CANDIDATE_COLLECTION_WINDOW_MS}ms`,
    );
    await new Promise<void>((resolve) => {
      this.collectionResolve = resolve;
      this.collectionTimer = setTimeout(() => {
        this.collectionTimer = undefined;
        this.collectionResolve = undefined;
        resolve();
      }, CANDIDATE_COLLECTION_WINDOW_MS);
    });
    if (token !== this.electionToken) return;

    const orderedCandidates =
      await hostService.getOrderedElectionCandidates(deadHostPeerId);
    if (token !== this.electionToken) return;

    console.log(
      `[RtcHostElectionCoordinator] Candidates for dead host=${short(deadHostPeerId)}: [${orderedCandidates.map(short).join(", ")}]`,
    );

    const myPosition = orderedCandidates.indexOf(localPeerId);
    if (myPosition === -1) {
      console.warn(
        `[RtcHostElectionCoordinator] Local peer ${short(localPeerId)} not in candidate list — skipping`,
      );
      return;
    }

    const delay = myPosition * POSITION_INTERVAL_MS;
    console.log(
      `[RtcHostElectionCoordinator] Countdown started — position=${myPosition} delay=${delay}ms`,
    );

    this.electionCountdown = setTimeout(async () => {
      this.electionCountdown = undefined;
      if (token !== this.electionToken) return;
      console.log(
        "[RtcHostElectionCoordinator] Countdown fired — electing next host",
      );
      await hostService.electNextHost(deadHostPeerId);
      if (token === this.electionToken) {
        this.currentElectionDeadHostId = undefined;
      }
    }, delay);
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
