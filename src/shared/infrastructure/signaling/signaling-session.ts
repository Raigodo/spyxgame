import type { Clock, IdGenerator, Logger, SignalingConfig } from "@/shared/kernel";
import { SignalingPeerTracker } from "./signaling-peer-tracker";
import type {
  RoomId,
  SignalingMessage,
  SignalingPeer,
  SignalingPeerId,
  WebRtcSignal,
} from "./types";
import { HostElectionService } from "./host-election-service";
import { PendingSignalAckTracker } from "./pending-signal-ack-tracker";
import type { HostElectionPort } from "./ports/host-election-port";
import type { RoomMembershipPort } from "./ports/room-membership-port";
import type { SignalInboxPort } from "./ports/signal-inbox-port";
import { SignalingMailbox } from "./signaling-mailbox";

type SignalReceivedHandler = (message: SignalingMessage<WebRtcSignal>) => void;

export interface SignalingSessionDeps {
  membership: RoomMembershipPort;
  messages: SignalInboxPort;
  election: HostElectionPort;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: SignalingConfig;
}

export class SignalingSession {
  private readonly tracker = new SignalingPeerTracker();
  private hostElectionService?: HostElectionService;
  private ackTracker?: PendingSignalAckTracker;
  private mailbox?: SignalingMailbox;
  private unsubscribeFromPeers?: () => void;

  private readonly signalReceivedHandlers = new Set<SignalReceivedHandler>();

  private localRoomId?: RoomId;
  private localPeerId?: SignalingPeerId;

  constructor(private readonly deps: SignalingSessionDeps) {}

  get roomId() {
    return this.localRoomId;
  }

  get peerId() {
    return this.localPeerId;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async joinRoom(
    roomId: RoomId,
    peerId: SignalingPeerId = this.deps.ids.next()
  ): Promise<SignalingPeerId> {
    const { membership, messages, election, clock, ids, logger, config } = this.deps;
    if (this.localPeerId) {
      throw new Error("Already joined a room.");
    }

    const roomExists = await membership.roomExists(roomId);
    if (!roomExists) {
      await membership.createRoom(roomId);
    }

    this.localRoomId = roomId;
    this.localPeerId = peerId;

    await membership.addPeer(roomId, peerId, new Date(clock.now()));

    const mailbox = new SignalingMailbox({
      inbox: messages,
      ids,
      clock,
      logger: logger.child("mailbox"),
      roomId,
      localPeerId: peerId,
    });
    this.mailbox = mailbox;
    this.ackTracker = new PendingSignalAckTracker({
      mailbox,
      clock,
      logger: logger.child("acks"),
      config,
      onTimedOut: (deadPeerId) => {
        void membership.removePeer(roomId, deadPeerId);
      },
    });

    mailbox.startReceivingFor(peerId, (message) => {
      // The session doesn't interpret signal payloads; the RTC layer does.
      this.ackTracker?.acknowledge(message.fromPeerId);
      this.handleSignalReceived(message as SignalingMessage<WebRtcSignal>);
    });

    this.startTrackingPeers();

    this.hostElectionService = new HostElectionService({
      membership,
      election,
      messages,
      clock,
      logger: logger.child("election"),
      config,
      roomId,
      localPeerId: peerId,
    });
    this.hostElectionService.start();

    return peerId;
  }

  async leaveRoom(): Promise<void> {
    if (!this.localRoomId || !this.localPeerId) {
      return;
    }

    const { membership, messages, election, logger } = this.deps;
    const roomId = this.localRoomId;
    const localPeerId = this.localPeerId;

    this.stopTrackingPeers();
    this.mailbox?.stopReceiving();
    this.mailbox = undefined;
    this.ackTracker = undefined;

    await messages.clearInbox(roomId, localPeerId).catch((error) => {
      logger.warn("Failed to clear own inbox on leave", error);
    });

    const currentHost = await election.getHost(roomId);
    if (currentHost?.signalingPeerId === localPeerId) {
      logger.debug("Leaving as host, clearing host document");
      await election.clearHost(roomId);
    }

    // Best-effort cleanup of any election candidacy we registered. Not required for
    // correctness (candidate lists are filtered to live peers anyway), just tidier.
    await this.hostElectionService?.removeOwnCandidacy();

    this.hostElectionService?.stop();
    this.hostElectionService = undefined;

    this.tracker.clear();

    await membership.removePeer(roomId, localPeerId);

    this.localRoomId = undefined;
    this.localPeerId = undefined;
  }

  get host(): HostElectionService {
    if (!this.hostElectionService) {
      throw new Error("[SignalingSession] Not joined to a room.");
    }
    return this.hostElectionService;
  }

  getPeers(): SignalingPeer[] {
    return this.tracker.getAll();
  }

  onPeerJoined(handler: (peer: SignalingPeer) => void): () => void {
    return this.tracker.onPeerAdded(handler);
  }

  onPeerLeft(handler: (peer: SignalingPeer) => void): () => void {
    return this.tracker.onPeerRemoved(handler);
  }

  onSignalReceived(handler: SignalReceivedHandler): () => void {
    this.signalReceivedHandlers.add(handler);
    return () => this.signalReceivedHandlers.delete(handler);
  }

  async sendOffer(
    peerId: SignalingPeerId,
    sdp: string,
    onAckTimeout: "remove" | "do-nothing"
  ): Promise<void> {
    await this.sendSignal(peerId, { type: "offer", sdp }, onAckTimeout);
  }

  async sendAnswer(
    peerId: SignalingPeerId,
    sdp: string,
    onAckTimeout: "remove" | "do-nothing"
  ): Promise<void> {
    // peer may not be in tracker yet when replying to an offer
    await this.sendSignal(peerId, { type: "answer", sdp }, onAckTimeout, true);
  }

  async sendIceCandidate(
    peerId: SignalingPeerId,
    candidate: RTCIceCandidateInit,
    onAckTimeout: "remove" | "do-nothing"
  ): Promise<void> {
    // same reason: ICE flows before the tracker catches up
    await this.sendSignal(peerId, { type: "ice-candidate", candidate }, onAckTimeout, true);
  }

  // Forcibly removes another peer from the room. No liveness opinion here; that judgment
  // belongs to whoever calls this (see PlayerSession).
  async removePeer(peerId: SignalingPeerId): Promise<void> {
    if (!this.localRoomId) {
      throw new Error("[SignalingSession] Not joined to a room.");
    }
    await this.deps.membership.removePeer(this.localRoomId, peerId);
    await this.deps.messages.clearInbox(this.localRoomId, peerId).catch((error) => {
      this.deps.logger.warn("Failed to clear removed peer's inbox", error);
    });
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async sendSignal(
    peerId: SignalingPeerId,
    signal: WebRtcSignal,
    onAckTimeout: "remove" | "do-nothing",
    skipTrackerCheck = false
  ): Promise<void> {
    if (!this.localPeerId) {
      throw new Error("Cannot send a signal before joining a room.");
    }
    if (peerId === this.localPeerId) {
      throw new Error("Cannot send a signal to yourself.");
    }
    if (!skipTrackerCheck && !this.tracker.has(peerId)) {
      throw new Error(`Peer "${peerId}" is not in the room.`);
    }
    if (!this.mailbox || !this.ackTracker) {
      throw new Error("Message service is not initialized.");
    }

    const message = await this.mailbox.send({ toPeerId: peerId, payload: signal });
    this.ackTracker.track(peerId, message.id, onAckTimeout);
  }

  private startTrackingPeers(): void {
    if (!this.localRoomId) return;

    this.unsubscribeFromPeers = this.deps.membership.subscribeToPeers(this.localRoomId, (peers) =>
      this.reconcilePeers(peers)
    );
  }

  private stopTrackingPeers(): void {
    this.unsubscribeFromPeers?.();
    this.unsubscribeFromPeers = undefined;
  }

  // The single chokepoint for all peer state changes. Order is guaranteed: state is always
  // updated before events fire.
  private reconcilePeers(peers: SignalingPeer[]): void {
    const incomingIds = new Set(peers.map((p) => p.peerId));

    for (const peer of peers) {
      if (peer.peerId === this.localPeerId) continue;

      if (this.tracker.has(peer.peerId)) {
        this.tracker.update(peer);
      } else {
        this.tracker.add(peer);
      }
    }

    for (const existing of this.tracker.getAll()) {
      if (!incomingIds.has(existing.peerId)) {
        this.ackTracker?.forget(existing.peerId);
        this.tracker.remove(existing.peerId);
      }
    }
  }

  private handleSignalReceived(message: SignalingMessage<WebRtcSignal>): void {
    for (const handler of this.signalReceivedHandlers) handler(message);
  }
}
