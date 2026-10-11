import type { Cancel, Clock, PresenceConfig } from "@/shared/kernel";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { findSurvivor } from "./duplicate-rules";

interface ActiveDuplicate {
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  cancelSafety: Cancel;
}

export interface DuplicateViewDeps {
  clock: Clock;
  config: PresenceConfig;
  isPresent(peerId: SignalingPeerId): boolean;
  getPresentPeerIds(): ReadonlySet<SignalingPeerId>;
  /** A hidden newcomer was confirmed as the surviving side: fire its join now. */
  onReveal(peerId: SignalingPeerId): void;
  onChanged(): void;
}

// Every peer: which (playerId -> old/new peerId pair) is currently disputed. While a pair is
// disputed everyone shows one entry and withholds the newcomer until the outcome is known.
export class DuplicateView {
  private readonly active = new Map<string, ActiveDuplicate>();

  constructor(private readonly deps: DuplicateViewDeps) {}

  register(playerId: string, oldPeerId: SignalingPeerId, newPeerId: SignalingPeerId): void {
    if (this.active.has(playerId)) return;
    const cancelSafety = this.deps.clock.after(this.deps.config.duplicateRevealTimeoutMs, () => {
      // We never heard a definitive resolution (a dropped message, most likely): reveal
      // whichever side is actually still present rather than hiding it forever.
      this.active.delete(playerId);
      if (this.deps.isPresent(newPeerId)) this.deps.onReveal(newPeerId);
      this.deps.onChanged();
    });
    this.active.set(playerId, { oldPeerId, newPeerId, cancelSafety });
  }

  /** A peer left: if it was one side of a dispute, close it. Reveals the newcomer if the old side left. */
  resolveDeparted(departedPeerId: SignalingPeerId): void {
    for (const [playerId, duplicate] of this.active) {
      if (duplicate.oldPeerId !== departedPeerId && duplicate.newPeerId !== departedPeerId) {
        continue;
      }
      duplicate.cancelSafety();
      this.active.delete(playerId);

      // The ghost (old) left and the newcomer survived: it was hidden this whole time and needs
      // its join event fired now, for the first time.
      if (duplicate.oldPeerId === departedPeerId) this.deps.onReveal(duplicate.newPeerId);
      this.deps.onChanged();
      return;
    }
  }

  /** The newcomer's peerId if `departedPeerId` was the old side of a dispute and it is present. */
  survivorReplacing(departedPeerId: SignalingPeerId): SignalingPeerId | undefined {
    return findSurvivor(this.active.values(), departedPeerId, this.deps.getPresentPeerIds());
  }

  /** True for the newcomer's peerId while its duplicate is being arbitrated. */
  isHidden(peerId: SignalingPeerId): boolean {
    for (const d of this.active.values()) if (d.newPeerId === peerId) return true;
    return false;
  }

  /** True for the old peer's peerId while its duplicate is being arbitrated. */
  isReconnecting(peerId: SignalingPeerId): boolean {
    for (const d of this.active.values()) if (d.oldPeerId === peerId) return true;
    return false;
  }

  dispose(): void {
    for (const d of this.active.values()) d.cancelSafety();
    this.active.clear();
  }

  inspect(): Record<string, unknown> {
    return Object.fromEntries(
      Array.from(this.active, ([playerId, d]) => [
        playerId,
        { oldPeerId: d.oldPeerId, newPeerId: d.newPeerId },
      ])
    );
  }
}
