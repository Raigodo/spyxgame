import type { PlayerProfile, PlayerSession } from "@/shared/infrastructure/player";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RtcPeerStatus } from "@/shared/infrastructure/webrtc";

export interface PlayerPresence {
  status: RtcPeerStatus | "self";
  returning: boolean;
}

interface RestoredState {
  ready: boolean;
  teamId?: string;
}

type PresenceEntry = { status: RtcPeerStatus; returning: boolean };
type PresenceMap = Record<SignalingPeerId, PresenceEntry>;

type PresenceMessage = { __lobbyPresence: true; presence: PresenceMap };
type RestoreMessage = { __lobbyRestore: true; state: RestoredState };

type ChangeHandler = () => void;
type DuplicateHandler = () => void;

// Tracks connection status, "have we seen this playerId before" history, and
// "is this playerId already live elsewhere right now" duplicate detection.
//
//  - Every peer maintains `history` and does duplicate detection regardless
//    of role — both are cheap, and it means a peer promoted to host
//    mid-session isn't starting blank.
//  - Only whichever peer *currently is* host acts on connection status and
//    "returning" bookkeeping: observes real RTC statuses, decides who's
//    returning, sends them their old ready/team state, and broadcasts the
//    combined picture over the same generic app-message channel
//    LobbyController uses for mode switches.
//  - Duplicate-session detection is symmetric and needs no host
//    involvement: every peer independently compares its own playerId
//    against everyone else's, using a join-time timestamp frozen in
//    metadata (sessionStartedAt) to agree, without coordination, on which
//    of two concurrent sessions for the same playerId is older. The newer
//    one evicts itself by calling session.leave().
export class LobbyPresenceTracker {
  private readonly hostStatuses = new Map<SignalingPeerId, RtcPeerStatus>();
  private readonly returningPeerIds = new Set<SignalingPeerId>();
  private readonly history = new Map<string, RestoredState>();
  private remotePresence: PresenceMap = {};

  private readonly changeHandlers = new Set<ChangeHandler>();
  private readonly duplicateHandlers = new Set<DuplicateHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(private readonly session: PlayerSession) {
    const localPeerId = session.getLocalPlayer()?.peerId;
    for (const profile of session.getPlayers()) {
      if (profile.peerId === localPeerId) continue;
      const status = session.getPeerConnectionStatus(profile.peerId);
      if (status) this.hostStatuses.set(profile.peerId, status);
      this.checkForDuplicateSession(profile);
    }

    this.cleanupFns.push(
      session.onPeerConnectionStatusChanged((peer) => {
        if (!session.isHost()) return;
        this.hostStatuses.set(peer.signalingPeerId, peer.status);
        this.syncAndBroadcast();
      }),

      session.onPlayerJoined((profile) => {
        this.checkForDuplicateSession(profile);

        const playerId = readPlayerId(profile.metadata);

        if (session.isHost()) {
          this.hostStatuses.set(
            profile.peerId,
            session.getPeerConnectionStatus(profile.peerId) ?? "connecting"
          );

          const remembered = playerId ? this.history.get(playerId) : undefined;
          if (remembered) {
            this.returningPeerIds.add(profile.peerId);
            const restore: RestoreMessage = { __lobbyRestore: true, state: remembered };
            this.session.sendToPlayer(profile.peerId, restore);
          }

          this.syncAndBroadcast();
        }
      }),

      session.onPlayerLeft((profile) => {
        const playerId = readPlayerId(profile.metadata);
        if (playerId) {
          this.history.set(playerId, {
            ready: Boolean(profile.metadata.ready),
            teamId:
              typeof profile.metadata.teamId === "string" ? profile.metadata.teamId : undefined,
          });
        }

        if (session.isHost()) {
          this.hostStatuses.delete(profile.peerId);
          this.returningPeerIds.delete(profile.peerId);
          this.syncAndBroadcast();
        }
      }),

      session.onMessage((payload, from) => {
        if (from === session.getLocalPlayer()?.peerId) return; // our own broadcast, echoed back
        if (from !== session.getHostPeerId()) return; // only the host may speak for presence

        if (isPresenceMessage(payload)) {
          this.remotePresence = payload.presence;
          this.emitChanged();
        } else if (isRestoreMessage(payload)) {
          this.session.updateLocalProfile({
            metadata: {
              ready: payload.state.ready,
              ...(payload.state.teamId ? { teamId: payload.state.teamId } : {}),
            },
          });
        }
      })
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    this.hostStatuses.clear();
    this.returningPeerIds.clear();
    this.history.clear();
    this.remotePresence = {};
  }

  getPresence(targetPeerId: SignalingPeerId): PlayerPresence {
    const localPeerId = this.session.getLocalPlayer()?.peerId;

    if (targetPeerId === localPeerId) {
      return { status: "self", returning: this.remotePresence[targetPeerId]?.returning ?? false };
    }

    if (this.session.isHost()) {
      return {
        status: this.hostStatuses.get(targetPeerId) ?? "connecting",
        returning: this.returningPeerIds.has(targetPeerId),
      };
    }

    if (targetPeerId === this.session.getHostPeerId()) {
      return {
        status: this.session.getPeerConnectionStatus(targetPeerId) ?? "connecting",
        returning: this.remotePresence[targetPeerId]?.returning ?? false,
      };
    }

    const remote = this.remotePresence[targetPeerId];
    return { status: remote?.status ?? "connecting", returning: remote?.returning ?? false };
  }

  onChanged(handler: ChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  // Fires only on the session that loses the tie-break and is about to call
  // session.leave() on itself. The winning (older) session is never
  // notified — nothing changes for it.
  onDuplicateSessionRejected(handler: DuplicateHandler): () => void {
    this.duplicateHandlers.add(handler);
    return () => this.duplicateHandlers.delete(handler);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private checkForDuplicateSession(remoteProfile: PlayerProfile): void {
    const localProfile = this.session.getLocalPlayer();
    if (!localProfile || remoteProfile.peerId === localProfile.peerId) return;

    const myPlayerId = readPlayerId(localProfile.metadata);
    const theirPlayerId = readPlayerId(remoteProfile.metadata);
    if (!myPlayerId || !theirPlayerId || myPlayerId !== theirPlayerId) return;

    const mySessionStart = readSessionStart(localProfile.metadata);
    const theirSessionStart = readSessionStart(remoteProfile.metadata);

    // The newer session evicts itself; ties (same millisecond) are broken
    // deterministically so both sides agree without any coordination.
    const iAmNewer =
      mySessionStart !== theirSessionStart
        ? mySessionStart > theirSessionStart
        : localProfile.peerId > remoteProfile.peerId;

    if (!iAmNewer) return;

    for (const handler of this.duplicateHandlers) handler();
    this.session
      .leave()
      .catch((error) =>
        console.warn(
          "[LobbyPresenceTracker] Failed to leave after duplicate-session rejection",
          error
        )
      );
  }

  private syncAndBroadcast(): void {
    const presence: PresenceMap = {};
    for (const [peerId, status] of this.hostStatuses) {
      presence[peerId] = { status, returning: this.returningPeerIds.has(peerId) };
    }
    const message: PresenceMessage = { __lobbyPresence: true, presence };
    this.session.broadcast(message);
    this.emitChanged();
  }

  private emitChanged(): void {
    for (const handler of this.changeHandlers) handler();
  }
}

function readPlayerId(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.playerId === "string" ? metadata.playerId : undefined;
}

function readSessionStart(metadata: Record<string, unknown>): number {
  return typeof metadata.sessionStartedAt === "number" ? metadata.sessionStartedAt : 0;
}

function isPresenceMessage(value: unknown): value is PresenceMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__lobbyPresence === true
  );
}

function isRestoreMessage(value: unknown): value is RestoreMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__lobbyRestore === true
  );
}
