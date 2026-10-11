import type { BusStatus } from "@/shared/application/messaging";
import { Store, type Unsubscribe } from "@/shared/kernel";
import type { RoomPhase } from "./room-state";

export type ClientStatus = "idle" | "joining" | "syncing" | "ready" | "superseded" | "kicked";
export type Lifecycle = "idle" | "joining" | "joined" | "superseded" | "kicked";

export interface ClientLifecycleDeps {
  getBusStatus(): BusStatus | undefined;
  getRoomPhase(): RoomPhase | undefined;
  onListenerError?: (error: unknown) => void;
}

// The client's join state machine and the two values derived from it: status and phase.
// Phase stays undefined until the bus has been ready once, and keeps its value through re-syncs.
export class ClientLifecycle {
  private state: Lifecycle = "idle";
  private synced = false;
  private readonly status: Store<ClientStatus>;
  private readonly phase: Store<RoomPhase | undefined>;

  constructor(private readonly deps: ClientLifecycleDeps) {
    this.status = new Store<ClientStatus>("idle", Object.is, deps.onListenerError);
    this.phase = new Store<RoomPhase | undefined>(undefined, Object.is, deps.onListenerError);
  }

  get(): Lifecycle {
    return this.state;
  }
  set(next: Lifecycle): void {
    this.state = next;
  }
  hasSynced(): boolean {
    return this.synced;
  }
  /** Teardown: forget that we ever synced (no notification, as before). */
  resetSynced(): void {
    this.synced = false;
  }

  getStatus(): ClientStatus {
    return this.status.get();
  }
  getPhase(): RoomPhase | undefined {
    return this.phase.get();
  }
  onStatusChanged(handler: (status: ClientStatus) => void): Unsubscribe {
    return this.status.subscribe(handler);
  }
  onPhaseChanged(handler: (phase: RoomPhase | undefined) => void): Unsubscribe {
    return this.phase.subscribe(handler);
  }

  /** Recomputes status and phase from the current state and notifies on change. */
  sync(): void {
    const status = this.computeStatus();
    if (status === "ready") this.synced = true;
    const phase = this.synced ? this.deps.getRoomPhase() : undefined;
    this.status.set(status);
    this.phase.set(phase);
  }

  private computeStatus(): ClientStatus {
    switch (this.state) {
      case "idle":
        return "idle";
      case "joining":
        return "joining";
      case "superseded":
        return "superseded";
      case "kicked":
        return "kicked";
      case "joined":
        return this.deps.getBusStatus() ?? "syncing";
    }
  }
}
