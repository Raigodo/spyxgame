import { Countdown } from "./countdown";
import { firestoreClient } from "./firestore-client";
import { FirestoreGateway } from "./firestore-gateway";
import { FirestoreSignalingMessageService } from "./firestore-signaling-message-service";

import type {
  Participant,
  PeerId,
  RoomId,
  SignalingMessage,
  WebRtcSignal,
} from "./types";

interface ParticipantState {
  participant: Participant;
  messageTimeout?: Countdown;
}

type ParticipantJoinedHandler = (participant: Participant) => void;

type ParticipantLeftHandler = (participant: Participant) => void;

type SignalReceivedHandler = (message: SignalingMessage<WebRtcSignal>) => void;

export class FirestoreSignalingServiceRoot {
  private readonly gateway: FirestoreGateway;

  private readonly participants = new Map<PeerId, ParticipantState>();

  private readonly participantJoinedHandlers =
    new Set<ParticipantJoinedHandler>();

  private readonly participantLeftHandlers = new Set<ParticipantLeftHandler>();

  private readonly signalReceivedHandlers = new Set<SignalReceivedHandler>();

  private localMessageService?: FirestoreSignalingMessageService;

  private unsubscribeFromParticipants?: () => void;

  private roomId?: RoomId;
  private localPeerId?: PeerId;

  public constructor() {
    this.gateway = new FirestoreGateway(firestoreClient);
  }

  public async joinRoom(
    roomId: RoomId,
    peerId: PeerId = crypto.randomUUID(),
  ): Promise<PeerId> {
    if (this.localPeerId) {
      throw new Error("Already joined a room.");
    }

    const roomExists = await this.gateway.roomExists(roomId);

    if (!roomExists) {
      await this.gateway.createRoom(roomId);
    }

    this.roomId = roomId;
    this.localPeerId = peerId;

    await this.gateway.addParticipant(roomId, peerId, {
      joinedAt: new Date(),
    });

    this.localMessageService = new FirestoreSignalingMessageService(
      this.gateway,
      roomId,
      this.localPeerId,
    );

    this.localMessageService.startHandlingMessagesForParticipant(
      peerId,
      {
        async handle(message) {
          // The root service does not interpret the message.
        },
      },
      (message) => {
        this.handleSignalReceived(message as SignalingMessage<WebRtcSignal>);
      },
    );

    this.startTrackingParticipants();

    return peerId;
  }

  public async leaveRoom(): Promise<void> {
    if (!this.roomId || !this.localPeerId) {
      return;
    }

    const roomId = this.roomId;
    const localPeerId = this.localPeerId;

    this.stopTrackingParticipants();

    this.localMessageService?.stopHandlingMessages();
    this.localMessageService = undefined;

    this.participants.clear();

    await this.gateway.removeParticipant(roomId, localPeerId);

    this.roomId = undefined;
    this.localPeerId = undefined;
  }

  public getParticipants(): Participant[] {
    return Array.from(this.participants.values(), (state) => state.participant);
  }

  public onParticipantJoined(handler: ParticipantJoinedHandler): () => void {
    this.participantJoinedHandlers.add(handler);

    return () => {
      this.participantJoinedHandlers.delete(handler);
    };
  }

  public onParticipantLeft(handler: ParticipantLeftHandler): () => void {
    this.participantLeftHandlers.add(handler);

    return () => {
      this.participantLeftHandlers.delete(handler);
    };
  }

  public onSignalReceived(handler: SignalReceivedHandler): () => void {
    this.signalReceivedHandlers.add((x) => {
      const state = this.participants.get(x.fromPeerId);
      state?.messageTimeout?.stop();
      return handler(x);
    });

    return () => {
      this.signalReceivedHandlers.delete(handler);
    };
  }

  public async sendOfferToPeer(
    peerId: PeerId,
    sdp: string,
    onIgnoredStrategy: "remove" | "do-nothing" = "do-nothing",
  ): Promise<void> {
    await this.sendSignalToPeer(
      peerId,
      {
        type: "offer",
        sdp,
      },
      onIgnoredStrategy,
    );
  }

  public async sendAnswerToPeer(
    peerId: PeerId,
    sdp: string,
    onIgnoredStrategy: "remove" | "do-nothing" = "do-nothing",
  ): Promise<void> {
    await this.sendSignalToPeer(
      peerId,
      {
        type: "answer",
        sdp,
      },
      onIgnoredStrategy,
    );
  }

  public async sendIceCandidateToPeer(
    peerId: PeerId,
    candidate: RTCIceCandidateInit,
    onIgnoredStrategy: "remove" | "do-nothing" = "do-nothing",
  ): Promise<void> {
    await this.sendSignalToPeer(
      peerId,
      {
        type: "ice-candidate",
        candidate,
      },
      onIgnoredStrategy,
    );
  }

  private async sendSignalToPeer(
    peerId: PeerId,
    signal: WebRtcSignal,
    onIgnoredStrategy: "remove" | "do-nothing" = "do-nothing",
  ): Promise<void> {
    if (!this.localPeerId) {
      throw new Error("Cannot send a signal before joining a room.");
    }

    if (peerId === this.localPeerId) {
      throw new Error("Cannot send a signal to yourself.");
    }

    const state = this.participants.get(peerId);
    if (!state) {
      throw new Error(`Participant "${peerId}" is not in the room.`);
    }

    if (!this.localMessageService) {
      throw new Error("Signaling message service is not initialized.");
    }

    const message = await this.localMessageService.sendMessage({
      toPeerId: peerId,
      payload: signal,
    });

    state.messageTimeout ??= new Countdown(
      () =>
        this.roomId &&
        onIgnoredStrategy &&
        this.gateway.removeParticipant(this.roomId, peerId),
    );

    state.messageTimeout.start(15_000);
  }

  private startTrackingParticipants(): void {
    if (!this.roomId) {
      return;
    }

    this.unsubscribeFromParticipants = this.gateway.subscribeToParticipants(
      this.roomId,
      (participants) => {
        this.updateParticipants(participants);
      },
    );
  }

  private stopTrackingParticipants(): void {
    this.unsubscribeFromParticipants?.();
    this.unsubscribeFromParticipants = undefined;
  }

  private updateParticipants(participants: Participant[]): void {
    const nextParticipantIds = new Set(
      participants.map((participant) => participant.peerId),
    );

    for (const participant of participants) {
      if (participant.peerId === this.localPeerId) {
        continue;
      }

      if (this.participants.has(participant.peerId)) {
        const state = this.participants.get(participant.peerId)!;

        state.participant = participant;

        continue;
      }

      this.addParticipant(participant);
    }

    for (const [peerId, state] of this.participants) {
      if (nextParticipantIds.has(peerId)) {
        continue;
      }

      this.participants.delete(peerId);

      for (const handler of this.participantLeftHandlers) {
        handler(state.participant);
      }
    }
  }

  private addParticipant(participant: Participant): void {
    this.participants.set(participant.peerId, {
      participant,
    });

    for (const handler of this.participantJoinedHandlers) {
      handler(participant);
    }
  }

  private handleSignalReceived(message: SignalingMessage<WebRtcSignal>): void {
    for (const handler of this.signalReceivedHandlers) {
      handler(message);
    }
  }
}
