import { ChunkedMessenger } from "../webrtc/chunked-messenger";
import { PlayerDirectory } from "./player-directory";
import { WebRtcService } from "../webrtc/web-rtc-service";
import { RoomId, SignalingPeerId } from "../signaling";
import type { LocalProfileInput, PlayerProfile } from "./types";
import { RtcPeer, RtcPeerStatus } from "../webrtc/types";

type Envelope =
  | { kind: "profile"; profile: PlayerProfile }
  | { kind: "roster"; players: PlayerProfile[] }
  | { kind: "app"; scope: "broadcast"; from: SignalingPeerId; payload: unknown }
  | {
      kind: "app";
      scope: "direct";
      from: SignalingPeerId;
      to: SignalingPeerId;
      payload: unknown;
    };

type AppMessageHandler = (payload: unknown, from: SignalingPeerId) => void;
type PlayerHandler = (player: PlayerProfile) => void;

export class PlayerSession {
  private readonly messenger: ChunkedMessenger;
  private readonly directory = new PlayerDirectory();
  private readonly appMessageHandlers = new Set<AppMessageHandler>();
  private readonly cleanupFns: Array<() => void> = [];

  private localProfile?: PlayerProfile;

  constructor(private readonly rtc: WebRtcService) {
    this.messenger = new ChunkedMessenger(rtc);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async join(roomId: RoomId, profile: LocalProfileInput, peerId?: SignalingPeerId): Promise<void> {
    this.messenger.start();
    this.wireListeners(); // subscribe before joinRoom — avoids missing early events

    await this.rtc.joinRoom(roomId, peerId);

    this.localProfile = {
      peerId: this.rtc.getLocalPeerId()!,
      nickname: profile.nickname,
      metadata: profile.metadata ?? {},
      updatedAt: Date.now(),
    };
    this.directory.upsert(this.localProfile);

    if (this.rtc.isHost()) {
      this.broadcastRoster();
    } else {
      this.announceProfileToHost();
    }
  }

  async leave(): Promise<void> {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    this.messenger.stop();
    this.directory.clear();
    this.localProfile = undefined;
    await this.rtc.leaveRoom();
  }

  getLocalPlayer(): PlayerProfile | undefined {
    return this.localProfile;
  }

  getPlayers(): PlayerProfile[] {
    return this.directory.getAll();
  }

  getHostPeerId(): SignalingPeerId | undefined {
    return this.rtc.getHostPeerId();
  }

  // Shallow-merges metadata so games can update one field (e.g. `ready`)
  // without resending the whole bag.
  updateLocalProfile(patch: Partial<LocalProfileInput>): void {
    if (!this.localProfile) return;

    this.localProfile = {
      ...this.localProfile,
      nickname: patch.nickname ?? this.localProfile.nickname,
      metadata: patch.metadata
        ? { ...this.localProfile.metadata, ...patch.metadata }
        : this.localProfile.metadata,
      updatedAt: Date.now(),
    };
    this.directory.upsert(this.localProfile);

    if (this.rtc.isHost()) {
      this.broadcastRoster();
    } else {
      this.announceProfileToHost();
    }
  }

  onPlayerJoined(handler: PlayerHandler): () => void {
    return this.directory.onPlayerJoined(handler);
  }

  onPlayerUpdated(handler: PlayerHandler): () => void {
    return this.directory.onPlayerUpdated(handler);
  }

  onPlayerLeft(handler: PlayerHandler): () => void {
    return this.directory.onPlayerLeft(handler);
  }

  sendToPlayer(targetPeerId: SignalingPeerId, payload: unknown): void {
    const from = this.rtc.getLocalPeerId();
    if (!from) return;

    if (targetPeerId === from) {
      this.emitApp(payload, from);
      return;
    }

    const envelope: Envelope = {
      kind: "app",
      scope: "direct",
      from,
      to: targetPeerId,
      payload,
    };

    if (this.rtc.isHost()) {
      this.messenger.sendToPeer(targetPeerId, JSON.stringify(envelope));
    } else {
      const hostPeerId = this.rtc.getHostPeerId();
      if (!hostPeerId) return;
      this.messenger.sendToPeer(hostPeerId, JSON.stringify(envelope));
    }
  }

  broadcast(payload: unknown): void {
    const from = this.rtc.getLocalPeerId();
    if (!from) return;

    if (this.rtc.isHost()) {
      const envelope: Envelope = {
        kind: "app",
        scope: "broadcast",
        from,
        payload,
      };
      this.messenger.broadcast(JSON.stringify(envelope));
      this.emitApp(payload, from); // host has no RTC link to itself — deliver locally too
    } else {
      const hostPeerId = this.rtc.getHostPeerId();
      if (!hostPeerId) return;
      const envelope: Envelope = {
        kind: "app",
        scope: "broadcast",
        from,
        payload,
      };
      this.messenger.sendToPeer(hostPeerId, JSON.stringify(envelope));
    }
  }

  onMessage(handler: AppMessageHandler): () => void {
    this.appMessageHandlers.add(handler);
    return () => this.appMessageHandlers.delete(handler);
  }

  onPeerConnectionStatusChanged(handler: (peer: RtcPeer) => void): () => void {
    return this.rtc.onPeerStatusChanged(handler);
  }

  getPeerConnectionStatus(peerId: SignalingPeerId): RtcPeerStatus | undefined {
    return this.rtc.getPeers().find((p) => p.signalingPeerId === peerId)?.status;
  }

  isHost(): boolean {
    return this.rtc.isHost();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private wireListeners(): void {
    this.cleanupFns.push(
      this.messenger.onMessage((raw, from) => this.handleIncoming(raw, from)),

      this.rtc.onPeerLeft((peer) => {
        this.directory.remove(peer.signalingPeerId);
        if (this.rtc.isHost()) this.broadcastRoster();
      }),

      // A fresh host either already has a full roster (it was a guest a
      // moment ago and had been receiving broadcasts) or is the very first
      // peer in the room — either way, push out what it has so everyone
      // converges. A guest re-announces itself to make sure the (possibly
      // brand new) host definitely has its profile, rather than trusting
      // that the old host's in-memory state survived the handoff.
      this.rtc.onHostChanged(() => {
        if (this.rtc.isHost()) {
          this.broadcastRoster();
        } else {
          this.announceProfileToHost();
        }
      }),

      // onHostChanged can fire before the RTC link to that host is actually
      // up — sending then would silently no-op. Re-announce the moment the
      // connection to the (possibly new) host becomes active instead.
      this.rtc.onPeerStatusChanged((peer) => {
        if (
          peer.status === "active" &&
          !this.rtc.isHost() &&
          peer.signalingPeerId === this.rtc.getHostPeerId()
        ) {
          this.announceProfileToHost();
        }
      })
    );
  }

  private announceProfileToHost(): void {
    if (!this.localProfile) return;
    const hostPeerId = this.rtc.getHostPeerId();
    if (!hostPeerId || hostPeerId === this.localProfile.peerId) return;

    const envelope: Envelope = { kind: "profile", profile: this.localProfile };
    this.messenger.sendToPeer(hostPeerId, JSON.stringify(envelope));
  }

  private broadcastRoster(): void {
    const envelope: Envelope = {
      kind: "roster",
      players: this.directory.getAll(),
    };
    this.messenger.broadcast(JSON.stringify(envelope));
  }

  private handleIncoming(raw: string, from: SignalingPeerId): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      console.warn("[PlayerSession] Ignoring non-JSON message");
      return;
    }

    // The host is directly connected to every guest, so `from` here is the
    // verified identity of whoever actually sent this over the wire — it
    // cannot be spoofed. Anything a guest claims *inside* the envelope
    // (profile.peerId, envelope.from) is just data and must not be trusted.
    // This only applies at the host: a guest's `from` is always the host
    // itself (messages are relayed, not direct), so a guest has no way to
    // verify the original author and must keep trusting envelope.from as
    // stamped by the host.
    if (this.rtc.isHost()) {
      envelope = this.stampVerifiedSender(envelope, from);
    }

    switch (envelope.kind) {
      case "profile": {
        if (!this.rtc.isHost()) return; // only the host aggregates profiles
        this.directory.upsert(envelope.profile);
        this.broadcastRoster();
        break;
      }
      case "roster": {
        if (this.rtc.isHost()) return; // host is the source of truth, not a consumer
        this.directory.replaceAll(envelope.players);
        break;
      }
      case "app": {
        if (envelope.scope === "broadcast") {
          if (this.rtc.isHost()) {
            for (const peer of this.rtc.getPeers()) {
              if (peer.status !== "active" || peer.signalingPeerId === envelope.from) continue;
              this.messenger.sendToPeer(peer.signalingPeerId, raw);
            }
          }
          this.emitApp(envelope.payload, envelope.from);
        } else if (envelope.to === this.rtc.getLocalPeerId()) {
          this.emitApp(envelope.payload, envelope.from);
        } else if (this.rtc.isHost()) {
          this.messenger.sendToPeer(envelope.to, raw);
        }
        break;
      }
    }
  }

  private emitApp(payload: unknown, from: SignalingPeerId): void {
    for (const handler of this.appMessageHandlers) handler(payload, from);
  }

  private stampVerifiedSender(envelope: Envelope, verifiedFrom: SignalingPeerId): Envelope {
    switch (envelope.kind) {
      case "profile":
        return {
          ...envelope,
          profile: { ...envelope.profile, peerId: verifiedFrom },
        };
      case "app":
        return { ...envelope, from: verifiedFrom };
      case "roster":
        return envelope; // host never consumes a guest's roster claim anyway (early-return above)
    }
  }
}
