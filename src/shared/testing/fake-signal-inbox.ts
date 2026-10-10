import type {
  MessageId,
  RoomId,
  SignalInboxPort,
  SignalingMessage,
  SignalingPeerId,
} from "@/shared/infrastructure/signaling";
import type { Unsubscribe } from "@/shared/kernel";
import { FakeFirestoreState } from "./fake-firestore-state";
import { FakePortLife } from "./fake-port-life";

export class FakeSignalInbox implements SignalInboxPort {
  constructor(
    private readonly state: FakeFirestoreState,
    private readonly life = new FakePortLife()
  ) {}

  addMessage(roomId: RoomId, message: SignalingMessage): Promise<void> {
    return this.life.run(() => {
      this.state.stats.writes++;
      this.state.inbox(roomId, message.toPeerId).set(message.id, message);
      this.state.changed(roomId, `inbox:${message.toPeerId}`);
    });
  }

  deleteMessage(roomId: RoomId, peerId: SignalingPeerId, messageId: MessageId): Promise<void> {
    return this.life.run(() => {
      this.state.stats.deletes++;
      this.state.inbox(roomId, peerId).delete(messageId);
    });
  }

  messageExists(roomId: RoomId, peerId: SignalingPeerId, messageId: MessageId): Promise<boolean> {
    return this.life.run(() => {
      this.state.stats.reads++;
      return this.state.inbox(roomId, peerId).has(messageId);
    });
  }

  subscribeToMessages(
    roomId: RoomId,
    peerId: SignalingPeerId,
    onMessage: (message: SignalingMessage) => void
  ): Unsubscribe {
    const delivered = new Set<MessageId>();
    return this.life.subscribe(() =>
      this.state.subscribe(roomId, `inbox:${peerId}`, () => {
        const fresh = Array.from(this.state.inbox(roomId, peerId).values())
          .filter((m) => !delivered.has(m.id))
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        for (const message of fresh) {
          delivered.add(message.id);
          this.state.stats.reads++;
          onMessage(message);
        }
      })
    );
  }

  clearInbox(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    return this.life.run(() => {
      const inbox = this.state.inbox(roomId, peerId);
      this.state.stats.reads += Math.max(1, inbox.size);
      this.state.stats.deletes += inbox.size;
      inbox.clear();
    });
  }
}
