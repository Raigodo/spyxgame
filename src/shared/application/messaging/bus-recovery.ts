import type { Cancel, Clock } from "@/shared/kernel";
import { isRecoveryComplete, shouldReplaceBest } from "./bus-rules";
import type { PeerId } from "./types";
import type { ChannelCopy, Wire } from "./wire";

export interface HeldCommand {
  w: Extract<Wire, { kind: "command" }>;
  from: PeerId;
}

export interface RecoveryResult {
  /** Newest offered copy per channel. */
  best: ReadonlyMap<string, ChannelCopy>;
  offers: number;
  /** Commands that arrived during recovery, in arrival order. */
  held: readonly HeldCommand[];
}

export interface BusRecoveryDeps {
  clock: Clock;
  /** Finish this long after the last offer (sliding window). */
  windowMs: number;
  /** Finish this long after the start, whatever happens. */
  maxMs: number;
  /** For this long every expected peer is waited for; after it, only peers with an active link. */
  linkGraceMs: number;
  getLinkedPeerIds(): readonly PeerId[];
  getExpectedPeerIds(): readonly PeerId[];
  onFinish(result: RecoveryResult): void;
}

// One promotion recovery: collects every guest's copy of every channel and the commands that
// arrive meanwhile, and finishes (once) when everyone offered, the window slides out, or the cap
// hits. A newly promoted host may be a freshly refreshed tab with empty state, so nothing is
// published until this finishes.
export class BusRecovery {
  private readonly best = new Map<string, ChannelCopy>();
  private readonly offeredBy = new Set<PeerId>();
  private readonly held: HeldCommand[] = [];
  private cancelSlide?: Cancel;
  private readonly cancelMax: Cancel;
  private readonly cancelGrace: Cancel;
  private graceOver = false;
  private done = false;

  constructor(private readonly deps: BusRecoveryDeps) {
    this.cancelMax = deps.clock.after(deps.maxMs, () => this.finish());
    this.cancelGrace = deps.clock.after(deps.linkGraceMs, () => {
      this.graceOver = true;
      this.checkComplete(); // nothing else may happen: finish now if everyone linked has offered
    });
  }

  recordOffer(from: PeerId, channels: readonly ChannelCopy[]): void {
    if (this.done) return;
    this.offeredBy.add(from);
    for (const copy of channels) {
      if (shouldReplaceBest(copy, this.best.get(copy.ch))) this.best.set(copy.ch, copy);
    }
    this.noteActivity();
  }

  hold(w: HeldCommand["w"], from: PeerId): void {
    if (!this.done) this.held.push({ w, from });
  }

  /** Something happened (an offer, a link came up): restart the sliding window. */
  noteActivity(): void {
    if (this.done) return;
    this.cancelSlide?.();
    this.cancelSlide = this.deps.clock.after(this.deps.windowMs, () => this.finish());
    this.checkComplete();
  }

  /** Finishes now if every expected peer has offered (vacuously true with no peers). */
  checkComplete(): void {
    if (this.done) return;
    const expected = this.graceOver ? this.deps.getLinkedPeerIds() : this.deps.getExpectedPeerIds();
    if (isRecoveryComplete(expected, this.offeredBy)) this.finish();
  }

  /** Abandons the recovery without finishing (demotion, dispose). */
  cancel(): void {
    this.done = true;
    this.cancelSlide?.();
    this.cancelSlide = undefined;
    this.cancelMax();
    this.cancelGrace();
  }

  inspect(): Record<string, unknown> {
    return {
      offeredBy: Array.from(this.offeredBy),
      adopted: Array.from(this.best.keys()),
      held: this.held.length,
    };
  }

  private finish(): void {
    if (this.done) return;
    this.cancel();
    this.deps.onFinish({ best: this.best, offers: this.offeredBy.size, held: this.held });
  }
}
