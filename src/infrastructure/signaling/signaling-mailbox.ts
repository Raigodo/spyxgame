import type { SignalingMessageGateway } from "./signaling-message-gateway";
import type {
  MessageHandler,
  RoomId,
  SignalingMessage,
  SignalingPeerId,
} from "./types";

export class SignalingMailbox {
  private unsubscribeFromMessages?: () => void;

  public constructor(
    private readonly gateway: SignalingMessageGateway,
    private readonly roomId: RoomId,
    private readonly currentPeerId: SignalingPeerId,
  ) {}

  public async send<T>(
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

  public startReceivingFor<T>(
    peerId: SignalingPeerId,
    messageHandler: MessageHandler<T>,
    onMessageReceived?: (message: SignalingMessage<T>) => void,
  ): void {
    this.stopReceiving();

    this.unsubscribeFromMessages = this.gateway.subscribeToMessages(
      this.roomId,
      peerId,
      (message) =>
        void this.handleReceivedMessage(
          peerId,
          messageHandler,
          onMessageReceived,
          message as SignalingMessage<T>,
        ),
    );
  }

  public stopReceiving(): void {
    this.unsubscribeFromMessages?.();
    this.unsubscribeFromMessages = undefined;
  }

  private async handleReceivedMessage<T>(
    peerId: SignalingPeerId,
    messageHandler: MessageHandler<T>,
    onMessageReceived: ((message: SignalingMessage<T>) => void) | undefined,
    message: SignalingMessage<T>,
  ): Promise<void> {
    try {
      await messageHandler.handle(message);
      onMessageReceived?.(message);
      await this.gateway.deleteMessage(this.roomId, peerId, message.id);
    } catch (error) {
      console.warn(
        `[SignalingMailbox] Failed to handle signaling message "${message.id}".`,
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
