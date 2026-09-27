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
type DuplicateDetectedMessage = {
  __lobbyDuplicateDetected: true;
  playerId: string;
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
};

type ChangeHandler = () => void;
type SupersededHandler = () => void;
type RevealHandler = (peerId: SignalingPeerId) => void;

const PING_TIMEOUT_MS = 2000;

interface PendingArbitration {
  nonce: string;
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface ActiveDuplicate {
  oldPeerId: SignalingPeerId;
  newPeerId: SignalingPeerId;
  safetyTimeoutHandle: ReturnType<typeof setTimeout>;
}

// Tracks connection status, "have we seen this playerId before" history, and
// resolves the same-playerId-live-twice case.
//
//  - Connection status / "returning" bookkeeping: host-only, unchanged.
//  - Duplicate-session arbitration is host-only and liveness-based: when a
//    new peer's playerId matches an already-live peer, the host pings the
//    existing one and waits briefly. A reply means it's genuinely still
//    connected, so the newcomer is rejected. Silence means it's a ghost, so
//    the existing one is forcibly removed and the newcomer proceeds.
//  - Display hiding (this addition): the moment arbitration starts, the
//    host broadcasts which pair of peerIds is involved. Every peer —
//    including the host itself, applied directly rather than through its
//    own echoed broadcast — uses that to show ONE row for the disputed
//    playerId (the pre-existing one, as "reconnecting") instead of two, and
//    to withhold the newcomer's join event until the outcome is known. Pure
//    display bookkeeping: PlayerSession's own directory is never touched by
//    any of this, only what LobbyRoster chooses to expose.
export class LobbyPresenceTracker {
  private readonly hostStatuses = new Map<SignalingPeerId, RtcPeerStatus>();
  private readonly returningPeerIds = new Set<SignalingPeerId>();
  private readonly history = new Map<string, RestoredState>();
  private remotePresence: PresenceMap = {};

  // Host-only: tracks the ping/timeout for an in-flight liveness check.
  private readonly pendingArbitrations = new Map<string, PendingArbitration>();

  // Every peer: tracks which (playerId → old/new peerId pair) is currently
  // disputed, purely so getPresence()/isHiddenDuringArbitration() can hide
  // the duplicate consistently regardless of role.
  private readonly activeDuplicates = new Map<string, ActiveDuplicate>();

  private readonly changeHandlers = new Set<ChangeHandler>();
  private readonly supersededHandlers = new Set<SupersededHandler>();
  private readonly revealHandlers = new Set<RevealHandler>();
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

        this.resolveActiveDuplicate(profile.peerId);

        if (session.isHost()) {
          this.hostStatuses.delete(profile.peerId);
          this.returningPeerIds.delete(profile.peerId);
          this.syncAndBroadcast();
        }
      }),

      session.onMessage((payload, from) => {
        // These three can arrive at (or need applying by) anyone regardless
        // of role — a guest must answer a ping, act on a rejection, and
        // hide a duplicate, even though only the host ever initiates any of
        // them.
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
        if (isDuplicateDetectedMessage(payload) && from === session.getHostPeerId()) {
          this.registerActiveDuplicate(payload.playerId, payload.oldPeerId, payload.newPeerId);
          this.emitChanged();
          return;
        }

        if (from === session.getLocalPlayer()?.peerId) return; // our own broadcast, echoed back
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
    for (const duplicate of this.activeDuplicates.values()) {
      clearTimeout(duplicate.safetyTimeoutHandle);
    }
    this.pendingArbitrations.clear();
    this.activeDuplicates.clear();
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

    if (this.isReconnectingDuringArbitration(targetPeerId)) {
      return { status: "reconnecting", returning: this.returningPeerIds.has(targetPeerId) };
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

  // True for the newcomer's peerId while its duplicate is being arbitrated —
  // LobbyRoster filters these out of getPlayers() entirely, except for the
  // local player's own row (see LobbyRoster.getPlayers()), so a peer waiting
  // on its own arbitration outcome doesn't disappear from its own view.
  isHiddenDuringArbitration(peerId: SignalingPeerId): boolean {
    for (const duplicate of this.activeDuplicates.values()) {
      if (duplicate.newPeerId === peerId) return true;
    }
    return false;
  }

  private isReconnectingDuringArbitration(peerId: SignalingPeerId): boolean {
    for (const duplicate of this.activeDuplicates.values()) {
      if (duplicate.oldPeerId === peerId) return true;
    }
    return false;
  }

  onChanged(handler: ChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  // Fires on whichever side the host's arbitration rejects.
  onSessionSuperseded(handler: SupersededHandler): () => void {
    this.supersededHandlers.add(handler);
    return () => this.supersededHandlers.delete(handler);
  }

  // Fires with a peerId that was hidden as a newcomer-under-arbitration and
  // has now been confirmed as the surviving side — i.e. it should now be
  // treated as freshly joined, having never gotten its own join event
  // dispatched while it was hidden.
  onPeerRevealed(handler: RevealHandler): () => void {
    this.revealHandlers.add(handler);
    return () => this.revealHandlers.delete(handler);
  }

  // ─── Every peer — reacting to a duplicate-detected broadcast ──────────────

  private registerActiveDuplicate(
    playerId: string,
    oldPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): void {
    if (this.activeDuplicates.has(playerId)) return;
    const safetyTimeoutHandle = setTimeout(() => {
      // We never heard a definitive resolution (a dropped message,
      // most likely) — reveal whichever side is actually still present
      // rather than hiding it forever.
      this.activeDuplicates.delete(playerId);
      const stillThere = this.session.getPlayers().some((p) => p.peerId === newPeerId);
      if (stillThere) {
        for (const handler of this.revealHandlers) handler(newPeerId);
      }
      this.emitChanged();
    }, PING_TIMEOUT_MS * 2);

    this.activeDuplicates.set(playerId, { oldPeerId, newPeerId, safetyTimeoutHandle });
  }

  private resolveActiveDuplicate(departedPeerId: SignalingPeerId): void {
    for (const [playerId, duplicate] of this.activeDuplicates) {
      if (duplicate.oldPeerId !== departedPeerId && duplicate.newPeerId !== departedPeerId)
        continue;

      clearTimeout(duplicate.safetyTimeoutHandle);
      this.activeDuplicates.delete(playerId);

      // The ghost (old) left and the newcomer survived — it was hidden this
      // whole time and needs its join event fired now, for the first time.
      if (duplicate.oldPeerId === departedPeerId) {
        for (const handler of this.revealHandlers) handler(duplicate.newPeerId);
      }
      this.emitChanged();
      return;
    }
  }

  // ─── Host-only arbitration ──────────────────────────────────────────────

  private arbitrateIfDuplicate(newProfile: PlayerProfile): void {
    const localPeerId = this.session.getLocalPlayer()?.peerId;
    // Never treat our own local join as "the newcomer" — the
    // host-refreshes-itself case is handled by the existing dead-host
    // detection + returning-player restore instead, not this path.
    if (newProfile.peerId === localPeerId) return;

    const playerId = readPlayerId(newProfile.metadata);
    if (!playerId) return;
    if (this.pendingArbitrations.has(playerId)) return; // one arbitration at a time per playerId

    const existing = this.session
      .getPlayers()
      .find((p) => p.peerId !== newProfile.peerId && readPlayerId(p.metadata) === playerId);
    if (!existing) return;

    this.broadcastDuplicateDetected(playerId, existing.peerId, newProfile.peerId);

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
      this.reject(pending.newPeerId); // pre-existing connection answered — genuinely alive
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

  // Broadcasts the "hide this pair" signal for every OTHER peer, and applies
  // it directly to our own state too — necessary because our own broadcast
  // gets ignored by the `from === localPeerId` echo-guard above, same as
  // every other broadcast message in this class.
  private broadcastDuplicateDetected(
    playerId: string,
    oldPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): void {
    const message: DuplicateDetectedMessage = {
      __lobbyDuplicateDetected: true,
      playerId,
      oldPeerId,
      newPeerId,
    };
    this.session.broadcast(message);
    this.registerActiveDuplicate(playerId, oldPeerId, newPeerId);
    this.emitChanged();
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

function isDuplicateDetectedMessage(value: unknown): value is DuplicateDetectedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__lobbyDuplicateDetected === true
  );
}
