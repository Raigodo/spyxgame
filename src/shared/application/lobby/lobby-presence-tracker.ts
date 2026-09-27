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
type PingMessage = { __lobbyPing: true; nonce: string };
type PongMessage = { __lobbyPong: true; nonce: string };
type SessionRejectedMessage = { __lobbySessionRejected: true };

type ChangeHandler = () => void;
type SupersededHandler = () => void;

const PING_TIMEOUT_MS = 2000;

interface PendingArbitration {
  nonce: string;
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Tracks connection status, "have we seen this playerId before" history, and
// resolves the same-playerId-live-twice case.
//
//  - Connection status / "returning" bookkeeping: host-only, unchanged.
//  - Duplicate-session arbitration is host-only and liveness-based, not a
//    heuristic: when a new peer's playerId matches an already-live peer,
//    the host pings the existing one directly and waits briefly. A reply
//    means it's genuinely still connected, so the *newcomer* is rejected.
//    Silence means it's a ghost (most commonly a pre-refresh leftover), so
//    the *existing* one is forcibly removed via PlayerSession.hostRemovePeer
//    and the newcomer proceeds normally. Every peer, regardless of role,
//    must be able to answer a ping addressed to it and act on a rejection
//    addressed to it — only *initiating* a ping is host-only.
export class LobbyPresenceTracker {
  private readonly hostStatuses = new Map<SignalingPeerId, RtcPeerStatus>();
  private readonly returningPeerIds = new Set<SignalingPeerId>();
  private readonly history = new Map<string, RestoredState>();
  private remotePresence: PresenceMap = {};

  // Keyed by playerId, so a second join for the same playerId while an
  // arbitration is already in flight doesn't kick off an overlapping one.
  private readonly pendingArbitrations = new Map<string, PendingArbitration>();

  private readonly changeHandlers = new Set<ChangeHandler>();
  private readonly supersededHandlers = new Set<SupersededHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  constructor(private readonly session: PlayerSession) {
    const localPeerId = session.getLocalPlayer()?.peerId;
    for (const profile of session.getPlayers()) {
      if (profile.peerId === localPeerId) continue;
      const status = session.getPeerConnectionStatus(profile.peerId);
      if (status) this.hostStatuses.set(profile.peerId, status);
    }
    if (session.isHost()) {
      for (const profile of session.getPlayers()) {
        this.arbitrateIfDuplicate(profile);
      }
    }

    this.cleanupFns.push(
      session.onPeerConnectionStatusChanged((peer) => {
        if (!session.isHost()) return;
        this.hostStatuses.set(peer.signalingPeerId, peer.status);
        this.syncAndBroadcast();
      }),

      session.onPlayerJoined((profile) => {
        if (session.isHost()) {
          this.arbitrateIfDuplicate(profile);

          this.hostStatuses.set(
            profile.peerId,
            session.getPeerConnectionStatus(profile.peerId) ?? "connecting"
          );

          const playerId = readPlayerId(profile.metadata);
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

        // These two can arrive at anyone, regardless of role — a guest must
        // be able to answer a ping and act on a rejection even though only
        // the host ever sends either.
        if (isPingMessage(payload) && from === session.getHostPeerId()) {
          const pong: PongMessage = { __lobbyPong: true, nonce: payload.nonce };
          this.session.sendToPlayer(from, pong);
          return;
        }
        if (isSessionRejectedMessage(payload) && from === session.getHostPeerId()) {
          for (const handler of this.supersededHandlers) handler();
          this.session
            .leave()
            .catch((error) =>
              console.warn("[LobbyPresenceTracker] Failed to leave after rejection", error)
            );
          return;
        }

        if (from !== session.getHostPeerId()) return; // everything else is host-only broadcast

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
        } else if (isPongMessage(payload)) {
          this.handlePong(from, payload.nonce);
        }
      })
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    for (const arbitration of this.pendingArbitrations.values()) {
      clearTimeout(arbitration.timeoutHandle);
    }
    this.pendingArbitrations.clear();
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

  // Fires on whichever side the host's arbitration rejects — the newcomer
  // if the existing connection answered its ping, or the pre-existing one
  // if it turned out to be a ghost. Either way, that side is about to call
  // session.leave() on itself in response to the host's message.
  onSessionSuperseded(handler: SupersededHandler): () => void {
    this.supersededHandlers.add(handler);
    return () => this.supersededHandlers.delete(handler);
  }

  // ─── Private — host-only arbitration ───────────────────────────────────────

  private arbitrateIfDuplicate(newProfile: PlayerProfile): void {
    // Never treat our own local join as "the newcomer" — see the
    // host-refreshes-itself note above for why that case is handled
    // elsewhere instead.
    if (newProfile.peerId === this.session.getLocalPlayer()?.peerId) return;

    const playerId = readPlayerId(newProfile.metadata);
    if (!playerId) return;
    if (this.pendingArbitrations.has(playerId)) return; // one arbitration at a time per playerId

    const existing = this.session
      .getPlayers()
      .find((p) => p.peerId !== newProfile.peerId && readPlayerId(p.metadata) === playerId);
    if (!existing) return;

    const localPeerId = this.session.getLocalPlayer()?.peerId;

    // The host's own tab is trivially known to be alive — no ping needed.
    if (existing.peerId === localPeerId) {
      this.reject(newProfile.peerId);
      return;
    }

    const nonce = crypto.randomUUID();
    const timeoutHandle = setTimeout(() => {
      const pending = this.pendingArbitrations.get(playerId);
      if (!pending || pending.nonce !== nonce) return; // already resolved by a pong
      this.pendingArbitrations.delete(playerId);
      this.reject(pending.oldPeerId); // no reply in time — treat as a ghost
    }, PING_TIMEOUT_MS);

    this.pendingArbitrations.set(playerId, {
      nonce,
      oldPeerId: existing.peerId,
      newPeerId: newProfile.peerId,
      timeoutHandle,
    });

    const ping: PingMessage = { __lobbyPing: true, nonce };
    this.session.sendToPlayer(existing.peerId, ping);
  }

  private handlePong(fromPeerId: SignalingPeerId, nonce: string): void {
    for (const [playerId, pending] of this.pendingArbitrations) {
      if (pending.oldPeerId !== fromPeerId || pending.nonce !== nonce) continue;
      clearTimeout(pending.timeoutHandle);
      this.pendingArbitrations.delete(playerId);
      // The pre-existing connection answered — genuinely still alive, so
      // the newcomer is the one turned away.
      this.reject(pending.newPeerId);
      return;
    }
  }

  private reject(peerId: SignalingPeerId): void {
    const message: SessionRejectedMessage = { __lobbySessionRejected: true };
    this.session.sendToPlayer(peerId, message); // best-effort courtesy notice
    this.session
      .hostRemovePeer(peerId)
      .catch((error) =>
        console.warn("[LobbyPresenceTracker] Failed to remove rejected peer", error)
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

function isPingMessage(value: unknown): value is PingMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__lobbyPing === true
  );
}

function isPongMessage(value: unknown): value is PongMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__lobbyPong === true
  );
}

function isSessionRejectedMessage(value: unknown): value is SessionRejectedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__lobbySessionRejected === true
  );
}
