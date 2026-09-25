import type { HostElectionGateway } from "./host-election-gateway";
import { HostElectionService } from "./host-election-service";
import { PendingSignalAckTracker } from "./pending-signal-ack-tracker";
import type { RoomMembershipGateway } from "./room-membership-gateway";
import { SignalingMailbox } from "./signaling-mailbox";
import type { SignalingMessageGateway } from "./signaling-message-gateway";
import { SignalingPeerTracker } from "./signaling-peer-tracker";

import type {
  RoomId,
  SignalingMessage,
  SignalingPeer,
  SignalingPeerId,
  WebRtcSignal,
} from "./types";

type SignalReceivedHandler = (message: SignalingMessage<WebRtcSignal>) => void;

export class SignalingSession {
  private readonly tracker = new SignalingPeerTracker();
  private hostElectionService?: HostElectionService;
  private ackTracker?: PendingSignalAckTracker;
  private mailbox?: SignalingMailbox;
  private unsubscribeFromPeers?: () => void;

  private readonly signalReceivedHandlers = new Set<SignalReceivedHandler>();

  private localRoomId?: RoomId;
  private localPeerId?: SignalingPeerId;

  get roomId() {
    return this.localRoomId;
  }

  get peerId() {
    return this.localPeerId;
  }

  public constructor(
    private readonly membershipGateway: RoomMembershipGateway,
    private readonly messageGateway: SignalingMessageGateway,
    private readonly electionGateway: HostElectionGateway
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  public async joinRoom(
    roomId: RoomId,
    peerId: SignalingPeerId = crypto.randomUUID()
  ): Promise<SignalingPeerId> {
    if (this.localPeerId) {
      throw new Error("Already joined a room.");
    }

    const roomExists = await this.membershipGateway.roomExists(roomId);
    if (!roomExists) {
      await this.membershipGateway.createRoom(roomId);
    }

    this.localRoomId = roomId;
    this.localPeerId = peerId;

    const joinedAt = new Date();
    await this.membershipGateway.addPeer(roomId, peerId, { joinedAt });

    this.mailbox = new SignalingMailbox(this.messageGateway, roomId, peerId);
    this.ackTracker = new PendingSignalAckTracker(this.mailbox, (deadPeerId) => {
      void this.membershipGateway.removePeer(roomId, deadPeerId);
    });

    this.mailbox.startReceivingFor(
      peerId,
      {
        async handle() {
          // The session doesn't interpret signal payloads — the RTC layer does.
        },
      },
      (message) => {
        this.ackTracker?.acknowledge(message.fromPeerId);
        this.handleSignalReceived(message as SignalingMessage<WebRtcSignal>);
      }
    );

    this.startTrackingPeers();

    this.hostElectionService = new HostElectionService(
      this.membershipGateway,
      this.electionGateway,
      this.messageGateway,
      roomId,
      peerId
    );
    this.hostElectionService.start();

    return peerId;
  }

  public async leaveRoom(): Promise<void> {
    if (!this.localRoomId || !this.localPeerId) {
      return;
    }

    const roomId = this.localRoomId;
    const localPeerId = this.localPeerId;

    this.stopTrackingPeers();
    this.mailbox?.stopReceiving();
    this.mailbox = undefined;
    this.ackTracker = undefined;

    await this.messageGateway.clearInbox(roomId, localPeerId).catch((error) => {
      console.warn("[SignalingSession] Failed to clear own inbox on leave", error);
    });

    const currentHost = await this.electionGateway.getHost(roomId);
    if (currentHost?.signalingPeerId === localPeerId) {
      console.log("[SignalingSession] Leaving as host — clearing host document");
      await this.electionGateway.clearHost(roomId);
    }

    // Best-effort cleanup of any election candidacy we registered — not
    // required for correctness (candidate lists are filtered to live peers
    // anyway), just tidier.
    await this.hostElectionService?.removeOwnCandidacy();

    this.hostElectionService?.stop();
    this.hostElectionService = undefined;

    this.tracker.clear();

    await this.membershipGateway.removePeer(roomId, localPeerId);

    this.localRoomId = undefined;
    this.localPeerId = undefined;
  }

  public get host(): HostElectionService {
    if (!this.hostElectionService) {
      throw new Error("[SignalingSession] Not joined to a room.");
    }
    return this.hostElectionService;
  }

  public getPeers(): SignalingPeer[] {
    return this.tracker.getAll();
  }

  public onPeerJoined(handler: (peer: SignalingPeer) => void): () => void {
    return this.tracker.onPeerAdded(handler);
  }

  public onPeerLeft(handler: (peer: SignalingPeer) => void): () => void {
    return this.tracker.onPeerRemoved(handler);
  }

  public onSignalReceived(handler: SignalReceivedHandler): () => void {
    this.signalReceivedHandlers.add(handler);
    return () => this.signalReceivedHandlers.delete(handler);
  }

  public async sendOffer(
    peerId: SignalingPeerId,
    sdp: string,
    onAckTimeout: "remove" | "do-nothing"
  ): Promise<void> {
    await this.sendSignal(peerId, { type: "offer", sdp }, onAckTimeout);
  }

  public async sendAnswer(
    peerId: SignalingPeerId,
    sdp: string,
    onAckTimeout: "remove" | "do-nothing"
  ): Promise<void> {
    // peer may not be in tracker yet when replying to an offer
    await this.sendSignal(peerId, { type: "answer", sdp }, onAckTimeout, true);
  }

  public async sendIceCandidate(
    peerId: SignalingPeerId,
    candidate: RTCIceCandidateInit,
    onAckTimeout: "remove" | "do-nothing"
  ): Promise<void> {
    // same reason — ICE flows before tracker catches up
    await this.sendSignal(peerId, { type: "ice-candidate", candidate }, onAckTimeout, true);
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

    const message = await this.mailbox.send({
      toPeerId: peerId,
      payload: signal,
    });
    this.ackTracker.track(peerId, message.id, onAckTimeout);
  }

  private startTrackingPeers(): void {
    if (!this.localRoomId) return;

    this.unsubscribeFromPeers = this.membershipGateway.subscribeToPeers(this.localRoomId, (peers) =>
      this.reconcilePeers(peers)
    );
  }

  private stopTrackingPeers(): void {
    this.unsubscribeFromPeers?.();
    this.unsubscribeFromPeers = undefined;
  }

  // The single chokepoint for all peer state changes. Order is guaranteed:
  // state is always updated before events fire.
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
    for (const handler of this.signalReceivedHandlers) {
      handler(message);
    }
  }
}
