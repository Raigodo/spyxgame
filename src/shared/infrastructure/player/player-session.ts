import { Emitter, type Logger } from "@/shared/kernel";
import type { RoomId, SignalingPeerId } from "../signaling";
import type { ChunkedMessenger, FormerHost } from "../webrtc";
import type { HostTransferResult, RtcPeer, RtcPeerStatus } from "../webrtc/types";
import type { WebRtcService } from "../webrtc/web-rtc-service";
import { parseEnvelope, type Envelope } from "./envelope-parser";
import { PlayerDirectory } from "./player-directory";
import type { LocalProfileInput, PlayerProfile } from "./types";

export interface PlayerSessionDeps {
  rtc: WebRtcService;
  messenger: ChunkedMessenger;
  logger: Logger;
}

// Star topology: the host connects to every guest, guests only talk to the host, and the host
// relays broadcasts and direct messages after stamping the verified sender.
export class PlayerSession {
  private readonly rtc: WebRtcService;
  private readonly messenger: ChunkedMessenger;
  private readonly log: Logger;

  private readonly directory = new PlayerDirectory();
  private readonly appMessage = new Emitter<{ payload: unknown; from: SignalingPeerId }>();
  private readonly cleanupFns: Array<() => void> = [];

  private localProfile?: PlayerProfile;

  constructor(deps: PlayerSessionDeps) {
    this.rtc = deps.rtc;
    this.messenger = deps.messenger;
    this.log = deps.logger;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async join(
    roomId: RoomId,
    profile: LocalProfileInput,
    options: { peerId?: SignalingPeerId; formerHost?: FormerHost } = {}
  ): Promise<void> {
    this.messenger.start();
    this.wireListeners(); // subscribe before joinRoom: avoids missing early events

    await this.rtc.joinRoom(roomId, options.peerId, { formerHost: options.formerHost });

    this.localProfile = {
      peerId: this.rtc.getLocalPeerId()!,
      nickname: profile.nickname,
      metadata: profile.metadata ?? {},
      updatedAt: Date.now(),
    };
    this.directory.upsert(this.localProfile);

    if (this.rtc.isHost()) this.broadcastRoster();
    else this.announceProfileToHost();
  }

  async leave(): Promise<void> {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns.length = 0;
    this.messenger.stop();
    this.directory.clear();
    this.localProfile = undefined;
    await this.rtc.leaveRoom();
  }

  // Forcibly removes another player. Host-only. Purely mechanical: sends no notice to the
  // removed player. Callers that want them to clean up gracefully (arbitration, kick) message
  // them first.
  async hostRemovePeer(peerId: SignalingPeerId): Promise<void> {
    if (!this.isHost()) {
      throw new Error("[PlayerSession] Only the host can remove another player.");
    }
    await this.rtc.removePeer(peerId);
  }

  /** Host only. Hands the host role to `peerId`, which must have an active link. */
  transferHost(peerId: SignalingPeerId): Promise<HostTransferResult> {
    return this.rtc.transferHost(peerId);
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

  /** Peer ids with an RTC entry, in any status. Host side: who should offer after promotion. */
  getPeerIds(): SignalingPeerId[] {
    return this.rtc.getPeers().map((p) => p.signalingPeerId);
  }

  // Fires whenever the host changes (elected, re-elected, or cleared).
  onHostChanged(handler: (hostPeerId: SignalingPeerId | undefined) => void): () => void {
    return this.rtc.onHostChanged(handler);
  }

  // Shallow-merges metadata so games can update one field (e.g. `ready`) without resending the bag.
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

    if (this.rtc.isHost()) this.broadcastRoster();
    else this.announceProfileToHost();
  }

  onPlayerJoined(handler: (player: PlayerProfile) => void): () => void {
    return this.directory.onPlayerJoined(handler);
  }

  onPlayerUpdated(handler: (player: PlayerProfile) => void): () => void {
    return this.directory.onPlayerUpdated(handler);
  }

  onPlayerLeft(handler: (player: PlayerProfile) => void): () => void {
    return this.directory.onPlayerLeft(handler);
  }

  sendToPlayer(targetPeerId: SignalingPeerId, payload: unknown): void {
    const from = this.rtc.getLocalPeerId();
    if (!from) return;

    if (targetPeerId === from) {
      this.appMessage.emit({ payload, from });
      return;
    }

    const envelope: Envelope = { kind: "app", scope: "direct", from, to: targetPeerId, payload };

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

    const envelope: Envelope = { kind: "app", scope: "broadcast", from, payload };

    if (this.rtc.isHost()) {
      this.messenger.broadcast(JSON.stringify(envelope));
      this.appMessage.emit({ payload, from }); // host has no RTC link to itself: deliver locally too
    } else {
      const hostPeerId = this.rtc.getHostPeerId();
      if (!hostPeerId) return;
      this.messenger.sendToPeer(hostPeerId, JSON.stringify(envelope));
    }
  }

  onMessage(handler: (payload: unknown, from: SignalingPeerId) => void): () => void {
    return this.appMessage.on(({ payload, from }) => handler(payload, from));
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
        if (!this.directory.get(peer.signalingPeerId)) return; // already handled (e.g. removePeer then the snapshot)
        this.directory.remove(peer.signalingPeerId);
        if (this.rtc.isHost()) this.broadcastRoster();
      }),

      // A fresh host either already has a full roster (it was a guest a moment ago) or is the
      // very first peer in the room. Either way, drop entries for peers that already left, then
      // push out what it has so everyone converges. A guest re-announces itself so the (possibly
      // brand new) host definitely has its profile.
      this.rtc.onHostChanged(() => {
        if (this.rtc.isHost()) {
          this.pruneDepartedPlayers();
          this.broadcastRoster();
        } else {
          this.announceProfileToHost();
        }
      }),

      // onHostChanged can fire before the link to that host is actually up, and sending then
      // would silently no-op. Re-announce the moment the link to the host is active.
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

  // A newly promoted host inherits a roster that may list peers who already left. Membership is
  // the source of truth (its subscription is already open, so this costs no reads).
  private pruneDepartedPlayers(): void {
    const members = new Set(this.rtc.getMemberPeerIds());
    const localPeerId = this.rtc.getLocalPeerId();
    for (const player of this.directory.getAll()) {
      if (player.peerId !== localPeerId && !members.has(player.peerId)) {
        this.directory.remove(player.peerId);
      }
    }
  }

  private announceProfileToHost(): void {
    if (!this.localProfile) return;
    const hostPeerId = this.rtc.getHostPeerId();
    if (!hostPeerId || hostPeerId === this.localProfile.peerId) return;

    const envelope: Envelope = { kind: "profile", profile: this.localProfile };
    this.messenger.sendToPeer(hostPeerId, JSON.stringify(envelope));
  }

  private broadcastRoster(): void {
    const envelope: Envelope = { kind: "roster", players: this.directory.getAll() };
    this.messenger.broadcast(JSON.stringify(envelope));
  }

  private handleIncoming(raw: string, from: SignalingPeerId): void {
    let envelope = parseEnvelope(raw);
    if (!envelope) {
      this.log.warn("Ignoring malformed message");
      return;
    }

    // The host is directly connected to every guest, so `from` here is the verified identity of
    // whoever actually sent this over the wire. Anything a guest claims *inside* the envelope
    // (profile.peerId, envelope.from) is just data and must not be trusted. This only applies at
    // the host: a guest's `from` is always the host itself (messages are relayed), so a guest
    // keeps trusting envelope.from as stamped by the host.
    if (this.rtc.isHost()) {
      envelope = this.stampVerifiedSender(envelope, from);
    }

    // Relay the stamped envelope: guests must see the host-verified `from`.
    const relayed = this.rtc.isHost() ? JSON.stringify(envelope) : raw;

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
              this.messenger.sendToPeer(peer.signalingPeerId, relayed); // broadcast relay
            }
          }
          this.appMessage.emit({ payload: envelope.payload, from: envelope.from });
        } else if (envelope.to === this.rtc.getLocalPeerId()) {
          this.appMessage.emit({ payload: envelope.payload, from: envelope.from });
        } else if (this.rtc.isHost()) {
          this.messenger.sendToPeer(envelope.to, relayed); // direct relay
        }
        break;
      }
    }
  }

  private stampVerifiedSender(envelope: Envelope, verifiedFrom: SignalingPeerId): Envelope {
    switch (envelope.kind) {
      case "profile":
        return { ...envelope, profile: { ...envelope.profile, peerId: verifiedFrom } };
      case "app":
        return { ...envelope, from: verifiedFrom };
      case "roster":
        return envelope; // the host never consumes a guest's roster claim (early return above)
    }
  }
}
