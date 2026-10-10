import type {
  RoomId,
  RoomMembershipPort,
  SignalingPeer,
  SignalingPeerId,
} from "@/shared/infrastructure/signaling";
import type { Unsubscribe } from "@/shared/kernel";
import { FakeFirestoreState } from "./fake-firestore-state";
import { FakePortLife } from "./fake-port-life";

export class FakeRoomMembership implements RoomMembershipPort {
  constructor(
    private readonly state: FakeFirestoreState,
    private readonly life = new FakePortLife()
  ) {}

  createRoom(roomId: RoomId): Promise<void> {
    return this.life.run(() => {
      this.state.stats.writes++;
      this.state.room(roomId).created = true;
    });
  }

  roomExists(roomId: RoomId): Promise<boolean> {
    return this.life.run(() => {
      this.state.stats.reads++;
      return this.state.room(roomId).created;
    });
  }

  addPeer(roomId: RoomId, peerId: SignalingPeerId, joinedAt: Date): Promise<void> {
    return this.life.run(() => {
      this.state.stats.writes++;
      this.state.room(roomId).peers.set(peerId, joinedAt);
      this.state.changed(roomId, "peers");
    });
  }

  removePeer(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    return this.life.run(() => {
      this.state.stats.deletes++;
      if (this.state.room(roomId).peers.delete(peerId)) this.state.changed(roomId, "peers");
    });
  }

  peerExists(roomId: RoomId, peerId: SignalingPeerId): Promise<boolean> {
    return this.life.run(() => {
      this.state.stats.reads++;
      return this.state.room(roomId).peers.has(peerId);
    });
  }

  listPeers(roomId: RoomId): Promise<SignalingPeer[]> {
    return this.life.run(() => {
      const peers = this.sortedPeers(roomId);
      this.state.stats.reads += Math.max(1, peers.length);
      return peers;
    });
  }

  subscribeToPeers(roomId: RoomId, onChange: (peers: SignalingPeer[]) => void): Unsubscribe {
    return this.life.subscribe(() =>
      this.state.subscribe(roomId, "peers", () => onChange(this.sortedPeers(roomId)))
    );
  }

  private sortedPeers(roomId: RoomId): SignalingPeer[] {
    return Array.from(this.state.room(roomId).peers, ([peerId, joinedAt]) => ({
      peerId,
      joinedAt,
    })).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  }
}
