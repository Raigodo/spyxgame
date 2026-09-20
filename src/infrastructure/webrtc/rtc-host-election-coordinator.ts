// rtc-host-election-coordinator.ts

import type { FirestoreHostService } from "@infrastructure/signaling/firestore-host-service";
import type { RtcPeerRegistry } from "./rtc-peer-registry";
import type { SignalingPeerId } from "@infrastructure/signaling";

const POSITION_INTERVAL_MS = 5_000;

export class RtcHostElectionCoordinator {
  private electionCountdown?: ReturnType<typeof setTimeout>;
  private unsubscribeFromRegistry?: () => void;

  constructor(
    private readonly getHostService: () => FirestoreHostService,
    private readonly registry: RtcPeerRegistry,
  ) {}

  start(): void {
    this.unsubscribeFromRegistry = this.registry.onAnyStatusChanged(
      (status) => {
        if (status === "active") {
          console.log(
            "[RtcHostElectionCoordinator] Peer became active — cancelling countdown",
          );
          this.cancelCountdown();
        }
      },
    );
  }

  stop(): void {
    this.cancelCountdown();
    this.unsubscribeFromRegistry?.();
    this.unsubscribeFromRegistry = undefined;
  }

  startCountdown(deadHostPeerId: SignalingPeerId): void {
    this.cancelCountdown();

    const hostService = this.getHostService();
    const candidates = hostService
      .getCandidatesInLine()
      .filter((p) => p.peerId !== deadHostPeerId);

    console.log(
      `[RtcHostElectionCoordinator] Candidate line (excluding dead host): [${candidates.map((p) => short(p.peerId)).join(", ")}]`,
    );

    const localPeerId = hostService.localPeerId;
    const myPosition = candidates.findIndex((p) => p.peerId === localPeerId);

    if (myPosition === -1) {
      console.warn(
        `[RtcHostElectionCoordinator] Local peer ${short(localPeerId)} not in candidate line — skipping`,
      );
      return;
    }

    const delay = myPosition * POSITION_INTERVAL_MS;
    console.log(
      `[RtcHostElectionCoordinator] Countdown started — position=${myPosition} delay=${delay}ms`,
    );

    this.electionCountdown = setTimeout(async () => {
      this.electionCountdown = undefined;
      console.log(
        "[RtcHostElectionCoordinator] Countdown fired — electing next host",
      );
      await this.getHostService().electNextHost(deadHostPeerId);
    }, delay);
  }

  cancelCountdown(): void {
    if (this.electionCountdown) {
      console.log("[RtcHostElectionCoordinator] Countdown cancelled");
      clearTimeout(this.electionCountdown);
      this.electionCountdown = undefined;
    }
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
