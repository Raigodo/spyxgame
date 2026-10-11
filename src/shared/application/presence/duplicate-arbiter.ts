import type { Cancel, Clock, IdGenerator, Logger, PresenceConfig } from "@/shared/kernel";
import type { EventChannel } from "@/shared/application/messaging";
import type { PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import {
  findDuplicateGroups,
  findExistingDuplicate,
  planArbitration,
  readPlayerId,
} from "./duplicate-rules";
import type { PresenceEvent } from "./presence-events";

interface PendingArbitration {
  nonce: string;
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  cancelTimeout: Cancel;
}

export interface DuplicateArbiterDeps {
  session: PlayerSession;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: PresenceConfig;
  channel: EventChannel<PresenceEvent>;
  /** Tell every peer to hide this pair (and apply it locally). */
  announce(playerId: string, oldPeerId: SignalingPeerId, newPeerId: SignalingPeerId): void;
  /** Remove a peer after telling it why. */
  reject(peerId: SignalingPeerId): void;
}

// Host only: decides which of two peers sharing a playerId survives. The host pings the existing
// peer; a reply rejects the newcomer, silence removes the existing one as a ghost. Also runs on
// promotion, waiting for data-channel links first.
export class DuplicateArbiter {
  private readonly pending = new Map<string, PendingArbitration>();
  // Cancel functions for arbitrations waiting on data-channel links.
  private readonly linkWaits = new Set<() => void>();

  constructor(private readonly deps: DuplicateArbiterDeps) {}

  /** Lost the host role, or disposing: abandon everything in flight. */
  cancelAll(): void {
    for (const cancel of Array.from(this.linkWaits)) cancel();
    this.linkWaits.clear();
    for (const p of this.pending.values()) p.cancelTimeout();
    this.pending.clear();
  }

  // Arbitrates every playerId already present more than once. Waits for the data-channel links
  // first: a ping sent before the link is active is silently dropped, which would make a live
  // tab look like a ghost.
  arbitrateExisting(): void {
    const { session } = this.deps;
    const localPeerId = session.getLocalPlayer()?.peerId;

    for (const group of findDuplicateGroups(session.getPlayers(), localPeerId)) {
      this.afterLinksActive(group.involvedPeerIds, () => {
        if (!session.isHost()) return;
        const current = session.getPlayers().find((p) => p.peerId === group.newcomerPeerId);
        if (current) this.arbitrateIfDuplicate(current);
      });
    }
  }

  arbitrateIfDuplicate(newProfile: {
    peerId: SignalingPeerId;
    metadata: Record<string, unknown>;
  }): void {
    const { session, clock, ids, config, channel } = this.deps;
    const localPeerId = session.getLocalPlayer()?.peerId;
    // Never treat our own local join as "the newcomer": the host-refreshes-itself case is handled
    // by dead-host detection and the returning-player restore, not this path.
    if (newProfile.peerId === localPeerId) return;

    const playerId = readPlayerId(newProfile.metadata);
    if (!playerId) return;
    if (this.pending.has(playerId)) return; // one arbitration at a time per playerId

    const existing = findExistingDuplicate(session.getPlayers(), newProfile, playerId);
    if (!existing) return;

    this.deps.announce(playerId, existing.peerId, newProfile.peerId);

    if (planArbitration(existing.peerId, localPeerId) === "reject-newcomer") {
      this.deps.reject(newProfile.peerId); // the host's own tab is trivially alive: no ping needed
      return;
    }

    const nonce = ids.next();
    const cancelTimeout = clock.after(config.pingTimeoutMs, () => {
      const pending = this.pending.get(playerId);
      if (!pending || pending.nonce !== nonce) return; // already resolved by a pong
      this.pending.delete(playerId);
      this.deps.reject(pending.oldPeerId); // no reply in time: treat as a ghost
    });

    this.pending.set(playerId, {
      nonce,
      oldPeerId: existing.peerId,
      newPeerId: newProfile.peerId,
      cancelTimeout,
    });

    channel.sendTo(existing.peerId, { t: "ping", nonce });
  }

  handlePong(fromPeerId: SignalingPeerId, nonce: string): void {
    for (const [playerId, pending] of this.pending) {
      if (pending.oldPeerId !== fromPeerId || pending.nonce !== nonce) continue;
      pending.cancelTimeout();
      this.pending.delete(playerId);
      this.deps.reject(pending.newPeerId); // pre-existing connection answered: genuinely alive
      return;
    }
  }

  inspect(): Record<string, unknown> {
    return {
      pendingArbitrations: Object.fromEntries(
        Array.from(this.pending, ([playerId, p]) => [
          playerId,
          { oldPeerId: p.oldPeerId, newPeerId: p.newPeerId },
        ])
      ),
      linkWaits: this.linkWaits.size,
    };
  }

  private afterLinksActive(peerIds: SignalingPeerId[], run: () => void): void {
    const { session, clock, config } = this.deps;
    const ready = () => peerIds.every((id) => session.getPeerConnectionStatus(id) === "active");
    if (ready()) {
      run();
      return;
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      off();
      cancelTimer();
      this.linkWaits.delete(cancel);
      run();
    };
    const cancel = () => {
      finished = true;
      off();
      cancelTimer();
      this.linkWaits.delete(cancel);
    };
    const off = session.onPeerConnectionStatusChanged(() => {
      if (ready()) finish();
    });
    const cancelTimer = clock.after(config.linkWaitMs, finish);
    this.linkWaits.add(cancel);
  }
}
