import type {
  HostDocument,
  MessageId,
  RoomId,
  SignalingMessage,
  SignalingPeerId,
} from "@/shared/infrastructure/signaling";
import type { Unsubscribe } from "@/shared/kernel";

export interface FakeRoom {
  created: boolean;
  peers: Map<SignalingPeerId, Date>;
  inboxes: Map<SignalingPeerId, Map<MessageId, SignalingMessage>>;
  host: HostDocument | null;
  /** candidate peerId -> the dead host it registered for, and whether it confirmed */
  candidates: Map<SignalingPeerId, { dead: SignalingPeerId; confirmed: boolean }>;
}

interface Listener {
  active: boolean;
  deliver: () => void;
}

/**
 * The shared "server" behind the fake Firestore ports. Snapshot listeners fire in a microtask
 * (first with the current state, then after every change) and always read the state at delivery
 * time. Counters approximate cost: one read per call, per document for lists and inbox messages.
 */
export class FakeFirestoreState {
  readonly stats = { reads: 0, writes: 0, deletes: 0 };
  private readonly rooms = new Map<RoomId, FakeRoom>();
  private readonly listeners = new Map<string, Set<Listener>>();

  resetStats(): void {
    this.stats.reads = 0;
    this.stats.writes = 0;
    this.stats.deletes = 0;
  }

  room(roomId: RoomId): FakeRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        created: false,
        peers: new Map(),
        inboxes: new Map(),
        host: null,
        candidates: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  inbox(roomId: RoomId, peerId: SignalingPeerId): Map<MessageId, SignalingMessage> {
    const room = this.room(roomId);
    let inbox = room.inboxes.get(peerId);
    if (!inbox) {
      inbox = new Map();
      room.inboxes.set(peerId, inbox);
    }
    return inbox;
  }

  /** Topics: "peers", "host", `inbox:${peerId}`. */
  subscribe(roomId: RoomId, topic: string, deliver: () => void): Unsubscribe {
    const key = `${roomId}|${topic}`;
    const set = this.listeners.get(key) ?? new Set<Listener>();
    this.listeners.set(key, set);
    const listener: Listener = { active: true, deliver };
    set.add(listener);
    this.schedule(listener);
    return () => {
      listener.active = false;
      set.delete(listener);
    };
  }

  changed(roomId: RoomId, topic: string): void {
    for (const listener of this.listeners.get(`${roomId}|${topic}`) ?? []) {
      this.schedule(listener);
    }
  }

  private schedule(listener: Listener): void {
    queueMicrotask(() => {
      if (listener.active) listener.deliver();
    });
  }
}
