import type { PlayerSession } from "@/shared/infrastructure/player";
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

// Tracks connection status and "have we seen this playerId before" history,
// and keeps every peer's view of both in sync, despite star topology meaning
// only the host ever has a real RTC link to more than one other peer.
//
// Every peer maintains `history` regardless of role — it's cheap, and it
// means a peer promoted to host mid-session (after the old host died) isn't
// starting blank. But only whichever peer *currently is* host acts on it:
// observes real statuses, decides who's returning, sends them their old
// ready/team state, and broadcasts the combined picture over the same
// generic app-message channel LobbyController already uses for mode
// switches. Everyone else consumes that broadcast, except for their own
// single real link (to the host), which they read firsthand instead.
export class LobbyPresenceTracker {
  private readonly hostStatuses = new Map<SignalingPeerId, RtcPeerStatus>();
  private readonly returningPeerIds = new Set<SignalingPeerId>();
  private readonly history = new Map<string, RestoredState>();
  private remotePresence: PresenceMap = {};

  private readonly changeHandlers = new Set<ChangeHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(private readonly session: PlayerSession) {
    const localPeerId = session.getLocalPlayer()?.peerId;
    for (const profile of session.getPlayers()) {
      if (profile.peerId === localPeerId) continue;
      const status = session.getPeerConnectionStatus(profile.peerId);
      if (status) this.hostStatuses.set(profile.peerId, status);
    }

    this.cleanupFns.push(
      session.onPeerConnectionStatusChanged((peer) => {
        // When we're not host, this event only ever describes our own
        // guest→host link — that's read firsthand in getPresence(), not
        // stored here, so it doesn't leak into "status of other guests".
        if (!session.isHost()) return;
        this.hostStatuses.set(peer.signalingPeerId, peer.status);
        this.syncAndBroadcast();
      }),

      session.onPlayerJoined((profile) => {
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

  // ─── Private ──────────────────────────────────────────────────────────────

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
