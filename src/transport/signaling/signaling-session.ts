import {
  Cell,
  Emitter,
  Scope,
  listenerFailure,
  logFailure,
  type Clock,
  type IdGenerator,
  type Logger,
  type PeerId,
  type RoomId,
  type Store,
} from "@/kernel";
import type { Member } from "../model";
import type { SignalingConfig } from "../config";
import { buildMembers, sameMembers } from "./member-map";
import { diffPeers } from "./peer-diff";
import { HostElectionService } from "./host-election-service";
import { PendingSignalAckTracker } from "./pending-signal-ack-tracker";
import { PeerRemover, type ManualRemovalReason } from "./peer-remover";
import type { HostElectionPort } from "./ports/host-election-port";
import type { RoomMembershipPort } from "./ports/room-membership-port";
import type { SignalInboxPort } from "./ports/signal-inbox-port";
import { SignalingMailbox } from "./signaling-mailbox";
import type { SignalingMessage, SignalingPeer } from "./types";

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
  private readonly onListenerError = listenerFailure(() => this.deps.logger);
  private readonly membersCell = new Cell<ReadonlyMap<PeerId, Member>>(new Map(), {
    equals: sameMembers,
    onError: this.onListenerError,
  });
  private readonly hostCell = new Cell<PeerId | undefined>(undefined, {
    onError: this.onListenerError,
  });
  private readonly peerJoined = new Emitter<Member>(this.onListenerError);
  private readonly peerLeft = new Emitter<Member>(this.onListenerError);
  private readonly signalReceived = new Emitter<SignalingMessage>(this.onListenerError);

  private hostElectionService?: HostElectionService;
  private ackTracker?: PendingSignalAckTracker;
  private remover?: PeerRemover;
  private ackTimeoutVeto: (peerId: PeerId) => boolean = () => false;
  private mailbox?: SignalingMailbox;
  /** Peer subscription, mailbox and host wiring: stopped first on leave, before the remote cleanup. */
  private listening?: Scope;

  private localRoomId?: RoomId;
  private localPeerId?: PeerId;

  constructor(private readonly deps: SignalingSessionDeps) {}

  get roomId() {
    return this.localRoomId;
  }

  get peerId() {
    return this.localPeerId;
  }

  /** Everyone in the room's membership except this peer, in join order. Says nothing about liveness. */
  get members(): Store<ReadonlyMap<PeerId, Member>> {
    return this.membersCell;
  }

  /** The peer the host document names, undefined when none. Updated before onHostChanged handlers run. */
  get hostPeerId(): Store<PeerId | undefined> {
    return this.hostCell;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async joinRoom(roomId: RoomId, peerId?: PeerId): Promise<PeerId> {
    const { membership, messages, election, clock, ids, logger, config } = this.deps;
    if (this.localPeerId) {
      throw new Error("Already joined a room.");
    }
    const localPeerId = peerId ?? (ids.next() as PeerId);

    const roomExists = await membership.roomExists(roomId);
    if (!roomExists) {
      await membership.createRoom(roomId);
    }

    this.localRoomId = roomId;
    this.localPeerId = localPeerId;
    const listening = new Scope({ onError: (e) => logger.error("Cleanup failed", e) });
    this.listening = listening;

    await membership.addPeer(roomId, localPeerId, new Date(clock.now()));

    const mailbox = new SignalingMailbox({
      inbox: messages,
      ids,
      clock,
      logger: logger.child("mailbox"),
      roomId,
      localPeerId,
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
        if (this.ackTimeoutVeto(deadPeerId as PeerId)) return; // alive by another route (open link)
        void remover
          .remove(deadPeerId, "ack-timeout")
          .catch(logFailure(logger, "remove unresponsive peer"));
      },
    });

    mailbox.startReceivingFor(localPeerId, (message) => {
      // The session doesn't interpret signal payloads; the RTC layer does.
      this.ackTracker?.acknowledge(message.fromPeerId);
      this.signalReceived.emit(message);
    });
    listening.add(() => mailbox.stopReceiving());

    listening.add(membership.subscribeToPeers(roomId, (peers) => this.reconcilePeers(peers)));

    const hostElection = new HostElectionService({
      membership,
      election,
      remover,
      clock,
      logger: logger.child("election"),
      config,
      roomId,
      localPeerId,
    });
    this.hostElectionService = hostElection;
    // Subscribed before start(), so the store is current by the time any later handler runs.
    listening.add(
      hostElection.onHostChanged((host) =>
        this.hostCell.set(host ? (host.signalingPeerId as PeerId) : undefined)
      )
    );
    hostElection.start();

    return localPeerId;
  }

  async leaveRoom(): Promise<void> {
    if (!this.localRoomId || !this.localPeerId) {
      return;
    }

    const { membership, messages, election, logger } = this.deps;
    const roomId = this.localRoomId;
    const localPeerId = this.localPeerId;
    const hostElection = this.hostElectionService;

    this.listening?.dispose();
    this.listening = undefined;
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
    this.hostCell.set(undefined);
    this.clearMembers();

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

  inspect(): Record<string, unknown> {
    return {
      roomId: this.localRoomId,
      peerId: this.localPeerId,
      members: Array.from(this.membersCell.get().keys()),
      election: this.hostElectionService?.inspect() ?? null,
      removals: this.remover?.inspect() ?? null,
    };
  }

  onPeerJoined(handler: (peer: Member) => void): () => void {
    return this.peerJoined.on(handler);
  }

  onPeerLeft(handler: (peer: Member) => void): () => void {
    return this.peerLeft.on(handler);
  }

  onSignalReceived(handler: (message: SignalingMessage) => void): () => void {
    return this.signalReceived.on(handler);
  }

  // Forcibly removes another peer from the room. No liveness opinion here; that judgment
  // belongs to whoever calls this (the relay's `drop`).
  async removePeer(peerId: PeerId, reason: ManualRemovalReason = "host-removed"): Promise<void> {
    if (!this.remover) {
      throw new Error("[SignalingSession] Not joined to a room.");
    }
    await this.remover.remove(peerId, reason);
  }

  /**
   * The RTC layer's say over ack-timeout removals: return true to keep the peer. Without a veto,
   * an unanswered signal removes the peer.
   */
  setAckTimeoutVeto(veto: (peerId: PeerId) => boolean): void {
    this.ackTimeoutVeto = veto;
  }

  /**
   * Delivers an opaque payload to a peer's inbox. The RTC layer owns what it means.
   * `requireMember`: refuse unless the peer is currently in the room (offers). Answers and ICE
   * flow before membership catches up, so they skip the check.
   */
  async sendSignal(
    peerId: PeerId,
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
    if (options.requireMember && !this.membersCell.get().has(peerId)) {
      throw new Error(`Peer "${peerId}" is not in the room.`);
    }
    if (!this.mailbox || !this.ackTracker) {
      throw new Error("Message service is not initialized.");
    }

    const message = await this.mailbox.send({ toPeerId: peerId, payload });
    this.ackTracker.track(peerId, message.id, onAckTimeout);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  // The map is updated before any event fires, so handlers always read consistent members.
  private reconcilePeers(peers: SignalingPeer[]): void {
    const previous = this.membersCell.get();
    const diff = diffPeers(Array.from(previous.keys()), peers, this.localPeerId);
    const next = buildMembers(previous, diff.upserts);

    for (const id of diff.removed) this.ackTracker?.forget(id);
    this.membersCell.set(next);

    for (const { peer, isNew } of diff.upserts) {
      const member = isNew ? next.get(peer.peerId as PeerId) : undefined;
      if (member) this.peerJoined.emit(member);
    }
    for (const id of diff.removed) {
      const member = previous.get(id as PeerId);
      if (member) this.peerLeft.emit(member);
    }
  }

  // Teardown parity with the old tracker: consumers hear a departure for everyone.
  private clearMembers(): void {
    const previous = this.membersCell.get();
    this.membersCell.set(new Map());
    for (const member of previous.values()) this.peerLeft.emit(member);
  }
}
