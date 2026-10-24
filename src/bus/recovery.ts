import type { Cancel, ChannelId, Clock, PeerId } from "@/kernel";
import type { BusConfig } from "./config";
import { isRecoveryComplete, shouldReplaceBest } from "./rules";
import type { BusMsgOf, ChannelCopy } from "./wire";

export interface HeldCommand {
  msg: BusMsgOf<"command">;
  from: PeerId;
}

export interface RecoveryResult {
  /** Newest offered copy per channel. */
  best: ReadonlyMap<ChannelId, ChannelCopy>;
  offers: number;
  /** Commands that arrived during recovery, in arrival order. */
  held: readonly HeldCommand[];
}

export interface BusRecoveryDeps {
  clock: Clock;
  config: Pick<BusConfig, "recoveryWindowMs" | "recoveryMaxMs" | "recoveryLinkGraceMs">;
  linkedPeerIds(): readonly PeerId[];
  expectedPeerIds(): readonly PeerId[];
  onFinish(result: RecoveryResult): void;
}

// One promotion recovery: collects every guest's copy of every channel and the commands that
// arrive meanwhile, and finishes (once) when everyone offered, the window slides out, or the cap
// hits. A newly promoted host may be a freshly refreshed tab with empty state, so nothing is
// published until this finishes.
export class BusRecovery {
  private readonly best = new Map<ChannelId, ChannelCopy>();
  private readonly offeredBy = new Set<PeerId>();
  private readonly held: HeldCommand[] = [];
  private cancelSlide?: Cancel;
  private readonly cancelMax: Cancel;
  private readonly cancelGrace: Cancel;
  private graceOver = false;
  private done = false;

  constructor(private readonly deps: BusRecoveryDeps) {
    const { clock, config } = deps;
    this.cancelMax = clock.after(config.recoveryMaxMs, () => this.finish());
    this.cancelGrace = clock.after(config.recoveryLinkGraceMs, () => {
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

  hold(msg: HeldCommand["msg"], from: PeerId): void {
    if (!this.done) this.held.push({ msg, from });
  }

  /** Something happened (an offer, a link came up): restart the sliding window. */
  noteActivity(): void {
    if (this.done) return;
    this.cancelSlide?.();
    this.cancelSlide = this.deps.clock.after(this.deps.config.recoveryWindowMs, () =>
      this.finish()
    );
    this.checkComplete();
  }

  /** Finishes now if every expected peer has offered (vacuously true with no peers). */
  checkComplete(): void {
    if (this.done) return;
    const expected = this.graceOver ? this.deps.linkedPeerIds() : this.deps.expectedPeerIds();
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

  private finish(): void {
    if (this.done) return;
    this.cancel();
    this.deps.onFinish({ best: this.best, offers: this.offeredBy.size, held: this.held });
  }
}
