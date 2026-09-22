import { Countdown } from "./countdown";
import { firestoreClient } from "./firestore-client";
import { FirestoreGateway } from "./firestore-gateway";
import { FirestoreHostService } from "./firestore-host-service";
import { FirestoreSignalingMessageService } from "./firestore-signaling-message-service";
import { SignalingPeerTracker } from "./signaling-peer-tracker";

import type {
  SignalingPeer,
  SignalingPeerId,
  RoomId,
  SignalingMessage,
  WebRtcSignal,
  MessageId,
} from "./types";

type SignalReceivedHandler = (message: SignalingMessage<WebRtcSignal>) => void;

export class FirestoreSignalingServiceRoot {
  private readonly gateway: FirestoreGateway;
  private readonly tracker = new SignalingPeerTracker();
  private hostService?: FirestoreHostService;

  // Countdowns are keyed by peerId, separate from tracker state.
  // A countdown tracks whether a sent message was ever acknowledged.
  private readonly pendingMessageTimeouts = new Map<
    SignalingPeerId,
    Countdown
  >();
  private readonly pendingSignals = new Map<
    SignalingPeerId,
    { messageId: MessageId; onIgnoredStrategy: "remove" | "do-nothing" }
  >();

  private readonly signalReceivedHandlers = new Set<SignalReceivedHandler>();

  private localMessageService?: FirestoreSignalingMessageService;
  private unsubscribeFromSignalingPeers?: () => void;

  private localRoomId?: RoomId;
  private localPeerId?: SignalingPeerId;

  get roomId() {
    return this.localRoomId;
  }

  get peerid() {
    return this.localPeerId;
  }

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

    this.localRoomId = roomId;
    this.localPeerId = peerId;

    const joinedAt = new Date();
    await this.gateway.addSignalingPeer(roomId, peerId, { joinedAt });

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

    this.hostService = new FirestoreHostService(this.gateway, roomId, {
      peerId,
      joinedAt,
    });
    this.hostService.start();

    return peerId;
  }

  public async leaveRoom(): Promise<void> {
    if (!this.localRoomId || !this.localPeerId) {
      return;
    }

    const roomId = this.localRoomId;
    const localPeerId = this.localPeerId;

    this.stopTrackingSignalingPeers();
    this.localMessageService?.stopHandlingMessages();
    this.localMessageService = undefined;

    // If this peer is the current host, clear the host document.
    const currentHost = await this.gateway.getHostCandidate(roomId);
    if (currentHost?.signalingPeerId === localPeerId) {
      console.log(
        "[FirestoreSignalingServiceRoot] Leaving as host — clearing host document",
      );
      await this.gateway.clearHostCandidate(roomId);
    }

    // Best-effort cleanup of any election candidacy we registered — leaves
    // no trace if we're leaving mid-election. Not required for correctness
    // (getOrderedElectionCandidates already filters to live signaling
    // peers), just tidier.
    await this.hostService?.removeElectionCandidate();

    this.hostService?.stop();
    this.hostService = undefined;

    this.tracker.clear();

    await this.gateway.removeSignalingPeer(roomId, localPeerId);

    this.localRoomId = undefined;
    this.localPeerId = undefined;
  }

  public get host(): FirestoreHostService {
    if (!this.hostService) {
      throw new Error("[FirestoreSignalingServiceRoot] Not joined to a room.");
    }
    return this.hostService;
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
      true, // peer may not be in tracker yet when we reply to an offer
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
      true, // same reason — ICE flows before tracker catches up
    );
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async sendSignalToPeer(
    peerId: SignalingPeerId,
    signal: WebRtcSignal,
    onIgnoredStrategy: "remove" | "do-nothing",
    skipTrackerCheck = false,
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
    if (!this.localMessageService) {
      throw new Error("Message service is not initialized.");
    }

    const message = await this.localMessageService.sendMessage({
      toPeerId: peerId,
      payload: signal,
    });

    // Always reflects the most recently sent, unacknowledged message for
    // this peer. The countdown callback below is created once and reused
    // across resets, so it must read this at fire-time rather than closing
    // over a single send's message/strategy — otherwise a reused countdown
    // checks a stale message id with a stale ignore-strategy.
    this.pendingSignals.set(peerId, {
      messageId: message.id,
      onIgnoredStrategy,
    });

    // One countdown per peer — reset it if a new message is sent before
    // the previous one was acknowledged. This avoids stacking timeouts.
    let countdown = this.pendingMessageTimeouts.get(peerId);

    if (!countdown) {
      countdown = new Countdown(async () => {
        this.pendingMessageTimeouts.delete(peerId);

        const pending = this.pendingSignals.get(peerId);
        this.pendingSignals.delete(peerId);
        if (!pending) return;

        if (pending.onIgnoredStrategy === "remove" && this.localRoomId) {
          const stillPending = await this.gateway.messageExists(
            this.localRoomId,
            peerId,
            pending.messageId,
          );
          if (stillPending) {
            await this.gateway.removeSignalingPeer(this.localRoomId, peerId);
          }
        }
      });
      this.pendingMessageTimeouts.set(peerId, countdown);
    }

    countdown.start(15_000);
  }

  private startTrackingSignalingPeers(): void {
    if (!this.localRoomId) {
      return;
    }

    this.unsubscribeFromSignalingPeers = this.gateway.subscribeToSignalingPeers(
      this.localRoomId,
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
        this.pendingSignals.delete(existing.peerId);

        // tracker.remove fires onPeerRemoved after the peer is out of state.
        this.tracker.remove(existing.peerId);
      }
    }
  }

  private handleSignalReceived(message: SignalingMessage<WebRtcSignal>): void {
    // Stop the timeout — the remote peer acknowledged our signal.
    this.pendingMessageTimeouts.get(message.fromPeerId)?.stop();
    this.pendingMessageTimeouts.delete(message.fromPeerId);
    this.pendingSignals.delete(message.fromPeerId);

    for (const handler of this.signalReceivedHandlers) {
      handler(message);
    }
  }
}
