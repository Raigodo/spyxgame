import {
  Emitter,
  logFailure,
  type Clock,
  type IdGenerator,
  type Logger,
  type SignalingConfig,
} from "@/shared/kernel";
import { SignalingPeerTracker } from "./signaling-peer-tracker";
import type { RoomId, SignalingMessage, SignalingPeer, SignalingPeerId } from "./types";
import { HostElectionService } from "./host-election-service";
import { PendingSignalAckTracker } from "./pending-signal-ack-tracker";
import { PeerRemover, type ManualRemovalReason } from "./peer-remover";
import type { HostElectionPort } from "./ports/host-election-port";
import type { RoomMembershipPort } from "./ports/room-membership-port";
import type { SignalInboxPort } from "./ports/signal-inbox-port";
import { SignalingMailbox } from "./signaling-mailbox";
import { diffPeers } from "./peer-diff";

type SignalReceivedHandler = (message: SignalingMessage) => void;

export interface SignalingSessionDeps {
  membership: RoomMembershipPort;
  messages: SignalInboxPort;
  election: HostElectionPort;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: SignalingConfig;
}

export class SignalingSession {
  private readonly tracker = new SignalingPeerTracker((error) =>
    this.deps.logger.error("Peer listener failed", error)
  );
  private hostElectionService?: HostElectionService;
  private ackTracker?: PendingSignalAckTracker;
  private remover?: PeerRemover;
  private ackTimeoutVeto: (peerId: SignalingPeerId) => boolean = () => false;
  private mailbox?: SignalingMailbox;
  private unsubscribeFromPeers?: () => void;

  private readonly signalReceived: Emitter<SignalingMessage>;

  private localRoomId?: RoomId;
  private localPeerId?: SignalingPeerId;

  constructor(
    private readonly deps: SignalingSessionDeps,
    onError?: (error: unknown) => void
  ) {
    this.signalReceived = new Emitter<SignalingMessage>(onError);
  }

  get roomId() {
    return this.localRoomId;
  }

  get peerId() {
    return this.localPeerId;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async joinRoom(
    roomId: RoomId,
    peerId: SignalingPeerId = this.deps.ids.next()
  ): Promise<SignalingPeerId> {
    const { membership, messages, election, clock, ids, logger, config } = this.deps;
    if (this.localPeerId) {
      throw new Error("Already joined a room.");
    }

    const roomExists = await membership.roomExists(roomId);
    if (!roomExists) {
      await membership.createRoom(roomId);
    }

    this.localRoomId = roomId;
    this.localPeerId = peerId;

    await membership.addPeer(roomId, peerId, new Date(clock.now()));

    const mailbox = new SignalingMailbox({
      inbox: messages,
      ids,
      clock,
      logger: logger.child("mailbox"),
      roomId,
      localPeerId: peerId,
    });
    this.mailbox = mailbox;
    const remover = new PeerRemover({
      membership,
      messages,
      logger: logger.child("remove"),
      roomId,
    });
    this.remover = remover;
    this.ackTracker = new PendingSignalAckTracker({
      mailbox,
      clock,
      logger: logger.child("acks"),
      config,
      onTimedOut: (deadPeerId) => {
        if (this.ackTimeoutVeto(deadPeerId)) return; // alive by another route (open link)
        void remover
          .remove(deadPeerId, "ack-timeout")
          .catch(logFailure(logger, "remove unresponsive peer"));
      },
    });

    mailbox.startReceivingFor(peerId, (message) => {
      // The session doesn't interpret signal payloads; the RTC layer does.
      this.ackTracker?.acknowledge(message.fromPeerId);
      this.handleSignalReceived(message);
    });

    this.startTrackingPeers();

    this.hostElectionService = new HostElectionService({
      membership,
      election,
      remover,
      clock,
      logger: logger.child("election"),
      config,
      roomId,
      localPeerId: peerId,
    });
    this.hostElectionService.start();

    return peerId;
  }

  async leaveRoom(): Promise<void> {
    if (!this.localRoomId || !this.localPeerId) {
      return;
    }

    const { membership, messages, election, logger } = this.deps;
    const roomId = this.localRoomId;
    const localPeerId = this.localPeerId;
    const hostElection = this.hostElectionService;

    this.stopTrackingPeers();
    this.mailbox?.stopReceiving();
    this.mailbox = undefined;
    this.ackTracker = undefined;
    this.remover = undefined;

    // Every remote step is best-effort: one failure must not skip the rest, above all the
    // membership removal, or a ghost stays in the room.
    await this.bestEffort("clear own inbox", () => messages.clearInbox(roomId, localPeerId));

    await this.bestEffort("release host seat", async () => {
      const currentHost = await election.getHost(roomId);
      if (currentHost?.signalingPeerId === localPeerId) {
        logger.debug("Leaving as host, clearing host document");
        await election.clearHost(roomId);
      }
    });

    // Not required for correctness (candidate lists are filtered to live peers), just tidier.
    await this.bestEffort("remove own candidacy", async () => {
      await hostElection?.removeOwnCandidacy();
    });

    hostElection?.stop();
    this.hostElectionService = undefined;
    this.tracker.clear();

    await this.bestEffort("remove own membership", () =>
      membership.removePeer(roomId, localPeerId)
    );

    this.localRoomId = undefined;
    this.localPeerId = undefined;
  }

  /** Runs one cleanup step; a failure is logged, never thrown. */
  private async bestEffort(what: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      logFailure(this.deps.logger, what)(error);
    }
  }

  get host(): HostElectionService {
    if (!this.hostElectionService) {
      throw new Error("[SignalingSession] Not joined to a room.");
    }
    return this.hostElectionService;
  }

  getPeers(): SignalingPeer[] {
    return this.tracker.getAll();
  }

  inspect(): Record<string, unknown> {
    return {
      roomId: this.localRoomId,
      peerId: this.localPeerId,
      members: this.tracker.getAll().map((p) => p.peerId),
      election: this.hostElectionService?.inspect() ?? null,
      removals: this.remover?.inspect() ?? null,
    };
  }

  onPeerJoined(handler: (peer: SignalingPeer) => void): () => void {
    return this.tracker.onPeerAdded(handler);
  }

  onPeerLeft(handler: (peer: SignalingPeer) => void): () => void {
    return this.tracker.onPeerRemoved(handler);
  }

  onSignalReceived(handler: SignalReceivedHandler): () => void {
    return this.signalReceived.on(handler);
  }

  // Forcibly removes another peer from the room. No liveness opinion here; that judgment
  // belongs to whoever calls this (see PlayerSession).
  async removePeer(
    peerId: SignalingPeerId,
    reason: ManualRemovalReason = "host-removed"
  ): Promise<void> {
    if (!this.remover) {
      throw new Error("[SignalingSession] Not joined to a room.");
    }
    await this.remover.remove(peerId, reason);
  }

  /**
   * The RTC layer's say over ack-timeout removals: return true to keep the peer (it may mark the
   * link fragile as a side effect). Without a veto, an unanswered signal removes the peer.
   */
  setAckTimeoutVeto(veto: (peerId: SignalingPeerId) => boolean): void {
    this.ackTimeoutVeto = veto;
  }

  /**
   * Delivers an opaque payload to a peer's inbox. The RTC layer owns what it means.
   * `requireMember`: refuse unless the peer is currently in the room (offers). Answers and ICE
   * flow before the tracker catches up, so they skip the check.
   */
  async sendSignal(
    peerId: SignalingPeerId,
    payload: unknown,
    onAckTimeout: "remove" | "do-nothing",
    options: { requireMember?: boolean } = {}
  ): Promise<void> {
    if (!this.localPeerId) {
      throw new Error("Cannot send a signal before joining a room.");
    }
    if (peerId === this.localPeerId) {
      throw new Error("Cannot send a signal to yourself.");
    }
    if (options.requireMember && !this.tracker.has(peerId)) {
      throw new Error(`Peer "${peerId}" is not in the room.`);
    }
    if (!this.mailbox || !this.ackTracker) {
      throw new Error("Message service is not initialized.");
    }

    const message = await this.mailbox.send({ toPeerId: peerId, payload });
    this.ackTracker.track(peerId, message.id, onAckTimeout);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private startTrackingPeers(): void {
    if (!this.localRoomId) return;

    this.unsubscribeFromPeers = this.deps.membership.subscribeToPeers(this.localRoomId, (peers) =>
      this.reconcilePeers(peers)
    );
  }

  private stopTrackingPeers(): void {
    this.unsubscribeFromPeers?.();
    this.unsubscribeFromPeers = undefined;
  }

  private reconcilePeers(peers: SignalingPeer[]): void {
    const known = this.tracker.getAll().map((p) => p.peerId);
    const diff = diffPeers(known, peers, this.localPeerId);

    for (const { peer, isNew } of diff.upserts) {
      if (isNew) this.tracker.add(peer);
      else this.tracker.update(peer);
    }
    for (const peerId of diff.removed) {
      this.ackTracker?.forget(peerId);
      this.tracker.remove(peerId);
    }
  }

  private handleSignalReceived(message: SignalingMessage): void {
    this.signalReceived.emit(message);
  }
}
