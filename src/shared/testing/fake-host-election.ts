import type {
  HostDocument,
  HostElectionPort,
  RoomId,
  SignalingPeerId,
} from "@/shared/infrastructure/signaling";
import type { Unsubscribe } from "@/shared/kernel";
import { FakeFirestoreState } from "./fake-firestore-state";
import { FakePortLife } from "./fake-port-life";
import { CandidateStage } from "../infrastructure/signaling/ports/host-election-port";

export class FakeHostElection implements HostElectionPort {
  constructor(
    private readonly state: FakeFirestoreState,
    private readonly life = new FakePortLife()
  ) {}

  getHost(roomId: RoomId): Promise<HostDocument | null> {
    return this.life.run(() => {
      this.state.stats.reads++;
      return this.currentHost(roomId);
    });
  }

  writeHost(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    return this.life.run(() => {
      this.state.stats.writes++;
      this.state.room(roomId).host = { signalingPeerId: peerId };
      this.state.changed(roomId, "host");
    });
  }

  clearHost(roomId: RoomId): Promise<void> {
    return this.life.run(() => {
      this.state.stats.deletes++;
      this.state.room(roomId).host = null;
      this.state.changed(roomId, "host");
    });
  }

  subscribeToHost(roomId: RoomId, onChange: (host: HostDocument | null) => void): Unsubscribe {
    return this.life.subscribe(() =>
      this.state.subscribe(roomId, "host", () => onChange(this.currentHost(roomId)))
    );
  }

  registerCandidate(
    roomId: RoomId,
    peerId: SignalingPeerId,
    deadHostPeerId: SignalingPeerId,
    stage: CandidateStage
  ): Promise<void> {
    return this.life.run(() => {
      this.state.stats.writes++;
      this.state.room(roomId).candidates.set(peerId, {
        dead: deadHostPeerId,
        confirmed: stage === "confirmed",
      });
    });
  }

  removeCandidate(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    return this.life.run(() => {
      this.state.stats.deletes++;
      this.state.room(roomId).candidates.delete(peerId);
    });
  }

  listCandidates(
    roomId: RoomId,
    deadHostPeerId: SignalingPeerId,
    stage?: CandidateStage
  ): Promise<SignalingPeerId[]> {
    return this.life.run(() => {
      const all = this.state.room(roomId).candidates;
      this.state.stats.reads += Math.max(1, all.size);
      return Array.from(all)
        .filter(([, c]) => c.dead === deadHostPeerId && (stage !== "confirmed" || c.confirmed))
        .map(([peerId]) => peerId);
    });
  }

  clearAllCandidates(roomId: RoomId): Promise<void> {
    return this.life.run(() => {
      const all = this.state.room(roomId).candidates;
      this.state.stats.reads += Math.max(1, all.size);
      this.state.stats.deletes += all.size;
      all.clear();
    });
  }

  claimHostIf(
    roomId: RoomId,
    expectedPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): Promise<boolean> {
    return this.life.run(() => {
      this.state.stats.reads++;
      const room = this.state.room(roomId);
      if (room.host?.signalingPeerId !== expectedPeerId) return false;
      this.state.stats.writes++;
      room.host = { signalingPeerId: newPeerId };
      this.state.changed(roomId, "host");
      return true;
    });
  }

  private currentHost(roomId: RoomId): HostDocument | null {
    const host = this.state.room(roomId).host;
    return host ? { ...host } : null;
  }
}
