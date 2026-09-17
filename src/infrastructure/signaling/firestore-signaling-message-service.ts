import type { FirestoreGateway } from "./firestore-gateway";
import type { MessageHandler, PeerId, RoomId, SignalingMessage } from "./types";

export class FirestoreSignalingMessageService {
  private unsubscribeFromMessages?: () => void;

  public constructor(
    private readonly gateway: FirestoreGateway,
    private readonly roomId: RoomId,
    private readonly currentPeerId: PeerId,
  ) {}

  public async sendMessage<T>(
    message: Omit<SignalingMessage<T>, "timestamp" | "fromPeerId" | "id">,
  ): Promise<SignalingMessage> {
    const enhancedMessage = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date(),
      fromPeerId: this.currentPeerId,
    };
    await this.gateway.addMessage(this.roomId, enhancedMessage);
    return enhancedMessage;
  }

  public startHandlingMessagesForParticipant<T>(
    participantId: PeerId,
    messageHandler: MessageHandler<T>,
    onMessageReceived?: (message: SignalingMessage<T>) => void,
  ): void {
    this.stopHandlingMessages();

    this.unsubscribeFromMessages = this.gateway.subscribeToMessages(
      this.roomId,
      participantId,
      (message) =>
        void this.handleReceivedMessage(
          participantId,
          messageHandler,
          onMessageReceived,
          message as SignalingMessage<T>,
        ),
    );
  }

  public stopHandlingMessages(): void {
    this.unsubscribeFromMessages?.();
    this.unsubscribeFromMessages = undefined;
  }

  private async handleReceivedMessage<T>(
    participantId: PeerId,
    messageHandler: MessageHandler<T>,
    onMessageReceived: ((message: SignalingMessage<T>) => void) | undefined,
    message: SignalingMessage<T>,
  ): Promise<void> {
    try {
      await messageHandler.handle(message);

      onMessageReceived?.(message);

      await this.gateway.deleteMessage(this.roomId, participantId, message.id);
    } catch (error) {
      console.error(
        `Failed to handle signaling message "${message.id}".`,
        error,
      );
    }
  }

  public async isMessageStillPending(
    message: Pick<SignalingMessage, "toPeerId" | "id">,
  ): Promise<boolean> {
    return this.gateway.messageExists(
      this.roomId,
      message.toPeerId,
      message.id,
    );
  }
}
