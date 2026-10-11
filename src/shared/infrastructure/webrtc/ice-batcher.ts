import type { Cancel, Clock } from "@/shared/kernel";
import type { IceCandidate } from "./ports/rtc-peer-connection-port";

export interface IceBatcherDeps {
  clock: Clock;
  windowMs: number;
  maxBatch: number;
  send(candidates: IceCandidate[]): void;
}

/** Collects one link's ICE candidates and hands them over in batches (one signal doc each). */
export class IceBatcher {
  private pending: IceCandidate[] = [];
  private cancelTimer?: Cancel;

  constructor(private readonly deps: IceBatcherDeps) {}

  add(candidate: IceCandidate): void {
    this.pending.push(candidate);
    if (this.pending.length >= this.deps.maxBatch) {
      this.flush();
      return;
    }
    // The window starts at the first candidate and does not slide.
    this.cancelTimer ??= this.deps.clock.after(this.deps.windowMs, () => this.flush());
  }

  flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.deps.send(batch);
  }

  /** Drops what is pending (the link is up, replaced or gone). */
  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.pending = [];
  }
}
