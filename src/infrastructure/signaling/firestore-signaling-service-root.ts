import { Countdown } from "./countdown";
import { firestoreClient } from "./firestore-client";
import { FirestoreGateway } from "./firestore-gateway";
import { FirestoreSignalingMessageService } from "./firestore-signaling-message-service";
import { SignalingPeerTracker } from "./signaling-peer-tracker";

import type {
  SignalingPeer,
  SignalingPeerId,
  RoomId,
  SignalingMessage,
  WebRtcSignal,
} from "./types";

type SignalReceivedHandler = (message: SignalingMessage<WebRtcSignal>) => void;

export class FirestoreSignalingServiceRoot {
  private readonly gateway: FirestoreGateway;
  private readonly tracker = new SignalingPeerTracker();

  // Countdowns are keyed by peerId, separate from tracker state.
  // A countdown tracks whether a sent message was ever acknowledged.
  private readonly pendingMessageTimeouts = new Map<
    SignalingPeerId,
    Countdown
  >();

  private readonly signalReceivedHandlers = new Set<SignalReceivedHandler>();

  private localMessageService?: FirestoreSignalingMessageService;
  private unsubscribeFromSignalingPeers?: () => void;

  private roomId?: RoomId;
  private localPeerId?: SignalingPeerId;

  public constructor() {
    this.gateway = new FirestoreGateway(firestoreClient);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  public async joinRoom(
    roomId: RoomId,
    peerId: SignalingPeerId = crypto.randomUUID(),
  ): Promise<SignalingPeerId> {
    if (this.localPeerId) {
      throw new Error("Already joined a room.");
    }

    const roomExists = await this.gateway.roomExists(roomId);
    if (!roomExists) {
      await this.gateway.createRoom(roomId);
    }

    this.roomId = roomId;
    this.localPeerId = peerId;

    await this.gateway.addSignalingPeer(roomId, peerId, {
      joinedAt: new Date(),
    });

    this.localMessageService = new FirestoreSignalingMessageService(
      this.gateway,
      roomId,
      this.localPeerId,
    );

    this.localMessageService.startHandlingMessagesForSignalingPeer(
      peerId,
      {
        async handle() {
          // Root service does not interpret signals — WebRTC service does.
        },
      },
      (message) => {
        this.handleSignalReceived(message as SignalingMessage<WebRtcSignal>);
      },
    );

    this.startTrackingSignalingPeers();

    return peerId;
  }

  public async leaveRoom(): Promise<void> {
    if (!this.roomId || !this.localPeerId) {
      return;
    }

    const roomId = this.roomId;
    const localPeerId = this.localPeerId;

    this.stopTrackingSignalingPeers();

    this.localMessageService?.stopHandlingMessages();
    this.localMessageService = undefined;

    // Stop all pending timeouts before clearing tracker —
    // tracker.clear() will fire onPeerRemoved for each peer.
    for (const countdown of this.pendingMessageTimeouts.values()) {
      countdown.stop();
    }
    this.pendingMessageTimeouts.clear();

    this.tracker.clear();

    await this.gateway.removeSignalingPeer(roomId, localPeerId);

    this.roomId = undefined;
    this.localPeerId = undefined;
  }

  public getSignalingPeers(): SignalingPeer[] {
    return this.tracker.getAll();
  }

  public onSignalingPeerJoined(
    handler: (peer: SignalingPeer) => void,
  ): () => void {
    return this.tracker.onPeerAdded(handler);
  }

  public onSignalingPeerLeft(
    handler: (peer: SignalingPeer) => void,
  ): () => void {
    return this.tracker.onPeerRemoved(handler);
  }

  public onSignalReceived(handler: SignalReceivedHandler): () => void {
    this.signalReceivedHandlers.add(handler);
    return () => this.signalReceivedHandlers.delete(handler);
  }

  public async sendOfferToPeer(
    peerId: SignalingPeerId,
    sdp: string,
    onIgnoredStrategy: "remove" | "do-nothing",
  ): Promise<void> {
    await this.sendSignalToPeer(
      peerId,
      { type: "offer", sdp },
      onIgnoredStrategy,
    );
  }

  public async sendAnswerToPeer(
    peerId: SignalingPeerId,
    sdp: string,
    onIgnoredStrategy: "remove" | "do-nothing",
  ): Promise<void> {
    await this.sendSignalToPeer(
      peerId,
      { type: "answer", sdp },
      onIgnoredStrategy,
    );
  }

  public async sendIceCandidateToPeer(
    peerId: SignalingPeerId,
    candidate: RTCIceCandidateInit,
    onIgnoredStrategy: "remove" | "do-nothing",
  ): Promise<void> {
    await this.sendSignalToPeer(
      peerId,
      { type: "ice-candidate", candidate },
      onIgnoredStrategy,
    );
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async sendSignalToPeer(
    peerId: SignalingPeerId,
    signal: WebRtcSignal,
    onIgnoredStrategy: "remove" | "do-nothing",
  ): Promise<void> {
    if (!this.localPeerId) {
      throw new Error("Cannot send a signal before joining a room.");
    }
    if (peerId === this.localPeerId) {
      throw new Error("Cannot send a signal to yourself.");
    }
    // Fail immediately — no sketchy "maybe it'll show up soon" logic.
    if (!this.tracker.has(peerId)) {
      throw new Error(`Peer "${peerId}" is not in the room.`);
    }
    if (!this.localMessageService) {
      throw new Error("Message service is not initialized.");
    }

    const message = await this.localMessageService.sendMessage({
      toPeerId: peerId,
      payload: signal,
    });

    // One countdown per peer — reset it if a new message is sent before
    // the previous one was acknowledged. This avoids stacking timeouts.
    let countdown = this.pendingMessageTimeouts.get(peerId);

    if (!countdown) {
      countdown = new Countdown(async () => {
        this.pendingMessageTimeouts.delete(peerId);

        if (onIgnoredStrategy === "remove" && this.roomId) {
          const stillPending = await this.gateway.messageExists(
            this.roomId,
            peerId,
            message.id,
          );
          if (stillPending) {
            await this.gateway.removeSignalingPeer(this.roomId, peerId);
          }
        }
      });
      this.pendingMessageTimeouts.set(peerId, countdown);
    }

    countdown.start(15_000);
  }

  private startTrackingSignalingPeers(): void {
    if (!this.roomId) {
      return;
    }

    this.unsubscribeFromSignalingPeers = this.gateway.subscribeToSignalingPeers(
      this.roomId,
      (peers) => this.reconcilePeers(peers),
    );
  }

  private stopTrackingSignalingPeers(): void {
    this.unsubscribeFromSignalingPeers?.();
    this.unsubscribeFromSignalingPeers = undefined;
  }

  // The single chokepoint for all peer state changes.
  // Order is guaranteed: state is always updated before events fire.
  private reconcilePeers(peers: SignalingPeer[]): void {
    const incomingIds = new Set(peers.map((p) => p.peerId));

    // Add new peers or update existing ones.
    for (const peer of peers) {
      if (peer.peerId === this.localPeerId) {
        continue;
      }

      if (this.tracker.has(peer.peerId)) {
        this.tracker.update(peer);
      } else {
        // tracker.add fires onPeerAdded after the peer is in state.
        // Any handler (e.g. WebRTC service) that calls tracker.get()
        // inside onPeerAdded will always succeed.
        this.tracker.add(peer);
      }
    }

    // Remove peers that are no longer present.
    for (const existing of this.tracker.getAll()) {
      if (!incomingIds.has(existing.peerId)) {
        // Stop their timeout before removing.
        this.pendingMessageTimeouts.get(existing.peerId)?.stop();
        this.pendingMessageTimeouts.delete(existing.peerId);

        // tracker.remove fires onPeerRemoved after the peer is out of state.
        this.tracker.remove(existing.peerId);
      }
    }
  }

  private handleSignalReceived(message: SignalingMessage<WebRtcSignal>): void {
    // Stop the timeout — the remote peer acknowledged our signal.
    this.pendingMessageTimeouts.get(message.fromPeerId)?.stop();
    this.pendingMessageTimeouts.delete(message.fromPeerId);

    for (const handler of this.signalReceivedHandlers) {
      handler(message);
    }
  }
}
