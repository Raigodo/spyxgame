// :::writing{variant="document" id="58321" title="Host-based WebRTC service"}
import {
  FirestoreSignalingService,
  IncomingSignal,
} from "@/infrastructure/signaling/firestore-client";

export interface HostWebRtcOptions {
  iceServers?: RTCIceServer[];
  dataChannelLabel?: string;

  /**
   * Maximum number of messages waiting for a peer's DataChannel to open.
   * Prevents an unbounded queue if a connection is broken.
   */
  maxPendingMessages?: number;
}

export type HostMessageHandler<T = unknown> = (
  fromPeerId: string,
  data: T,
) => void;

export type HostConnectionHandler = (peerId: string) => void;

interface PeerConnectionEntry {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;

  /**
   * ICE candidates can arrive before the remote description.
   */
  pendingCandidates: RTCIceCandidateInit[];

  /**
   * Signals can arrive before a PeerConnection exists.
   */
  pendingSignals: IncomingSignal[];

  remoteDescriptionSet: boolean;

  /**
   * Messages waiting for the DataChannel to open.
   */
  pendingMessages: string[];
}

interface NetworkMessage {
  type: "action";
  id: string;
  from: string;
  data: unknown;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: "stun:stun.l.google.com:19302",
  },
];

const DEFAULT_DATA_CHANNEL_LABEL = "host-network";

const DEFAULT_MAX_PENDING_MESSAGES = 100;

export class HostWebRtcService {
  private readonly signaling: FirestoreSignalingService;
  private readonly iceServers: RTCIceServer[];
  private readonly dataChannelLabel: string;
  private readonly maxPendingMessages: number;

  private readonly connections = new Map<string, PeerConnectionEntry>();

  /**
   * Signals which arrived before we knew that a peer existed.
   *
   * This is separate from PeerConnectionEntry.pendingSignals because there
   * may not even be a PeerConnectionEntry yet.
   */
  private readonly pendingSignalsByPeer = new Map<string, IncomingSignal[]>();

  private readonly messageHandlers = new Set<HostMessageHandler>();
  private readonly connectedHandlers = new Set<HostConnectionHandler>();
  private readonly disconnectedHandlers = new Set<HostConnectionHandler>();
  private readonly hostChangedHandlers = new Set<HostConnectionHandler>();

  private readonly unsubscribers: Array<() => void> = [];

  private currentHostId: string | null = null;

  /**
   * Used to avoid processing the same application message more than once.
   *
   * This matters particularly when host redistribution/reconnection logic
   * is added later.
   */
  private readonly processedMessageIds = new Set<string>();

  constructor(
    signaling: FirestoreSignalingService,
    options: HostWebRtcOptions = {},
  ) {
    this.signaling = signaling;
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.dataChannelLabel =
      options.dataChannelLabel ?? DEFAULT_DATA_CHANNEL_LABEL;
    this.maxPendingMessages =
      options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES;

    /*
     * Register handlers BEFORE joinRoom().
     *
     * FirestoreSignalingService itself starts listening during joinRoom(),
     * so this avoids a lifecycle gap where a signal could arrive before
     * WebRtcService has registered its handler.
     */
    this.unsubscribers.push(
      this.signaling.onSignal((signal) => {
        this.handleSignal(signal).catch((error) => {
          console.error(
            `[WebRTC] Failed to handle ${signal.type} from ${signal.from}`,
            error,
          );
        });
      }),

      this.signaling.onPeerJoined((peerId) => {
        this.handlePeerJoined(peerId).catch((error) => {
          console.error(`[WebRTC] Failed to handle peer join ${peerId}`, error);
        });
      }),

      this.signaling.onPeerLeft((peerId) => {
        this.handlePeerLeft(peerId);
      }),
    );
  }

  get roomId(): string | null {
    return this.signaling.currentRoomId;
  }

  get peerId(): string | null {
    return this.signaling.currentPeerId;
  }

  get hostId(): string | null {
    return this.currentHostId;
  }

  get isHost(): boolean {
    return this.peerId !== null && this.peerId === this.currentHostId;
  }

  /**
   * Joins the signaling room and establishes the host topology.
   */
  async joinRoom(roomId: string, peerId?: string) {
    const result = await this.signaling.joinRoom(roomId, peerId);

    /*
     * Determine the host deterministically.
     *
     * For the initial implementation we use the lexicographically smallest
     * peer ID. This means every participant independently reaches the same
     * conclusion without needing another Firestore document.
     */
    const allKnownPeers = [result.peerId, ...result.existingParticipants];

    this.recalculateHost(allKnownPeers);

    /*
     * If we are the host, create connections to everyone already present.
     *
     * Non-hosts deliberately do NOTHING here.
     */
    await this.reconcileConnections(allKnownPeers);

    return {
      ...result,
      hostId: this.currentHostId,
      isHost: this.isHost,
    };
  }

  /**
   * Leaves the room and closes every WebRTC connection.
   */
  async leaveRoom(): Promise<void> {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }

    this.unsubscribers.length = 0;

    for (const entry of this.connections.values()) {
      this.closeConnection(entry);
    }

    this.connections.clear();
    this.pendingSignalsByPeer.clear();
    this.processedMessageIds.clear();
    this.currentHostId = null;

    await this.signaling.leaveRoom();
  }

  /**
   * Send an application action.
   *
   * If we are a client:
   *
   *     client -> host
   *
   * If we are the host:
   *
   *     host -> everyone
   *
   * This is the only method your application normally needs to use.
   */
  send(data: unknown): boolean {
    const localPeerId = this.peerId;

    if (!localPeerId) {
      return false;
    }

    const message: NetworkMessage = {
      type: "action",
      id: crypto.randomUUID(),
      from: localPeerId,
      data,
    };

    if (this.isHost) {
      this.broadcastNetworkMessage(message);
      return true;
    }

    if (!this.currentHostId) {
      return false;
    }

    return this.sendRawToPeer(this.currentHostId, message);
  }

  /**
   * Host-only method for explicitly broadcasting data.
   *
   * Normally send() is enough because host messages are automatically
   * redistributed.
   */
  broadcast(data: unknown): boolean {
    if (!this.isHost || !this.peerId) {
      return false;
    }

    const message: NetworkMessage = {
      type: "action",
      id: crypto.randomUUID(),
      from: this.peerId,
      data,
    };

    this.broadcastNetworkMessage(message);

    return true;
  }

  /**
   * Returns the peers with an open WebRTC DataChannel.
   */
  getConnectedPeers(): string[] {
    return [...this.connections.entries()]
      .filter(([, entry]) => entry.channel?.readyState === "open")
      .map(([peerId]) => peerId);
  }

  getConnectionState(peerId: string): RTCPeerConnectionState | "absent" {
    return this.connections.get(peerId)?.pc.connectionState ?? "absent";
  }

  /**
   * Called whenever an application message reaches this peer.
   *
   * On a client this means:
   *
   *     host -> client
   *
   * On the host this means:
   *
   *     client -> host
   */
  onMessage<T = unknown>(callback: HostMessageHandler<T>): () => void {
    this.messageHandlers.add(callback as HostMessageHandler);

    return () => {
      this.messageHandlers.delete(callback as HostMessageHandler);
    };
  }

  onPeerConnected(callback: HostConnectionHandler): () => void {
    this.connectedHandlers.add(callback);

    return () => {
      this.connectedHandlers.delete(callback);
    };
  }

  onPeerDisconnected(callback: HostConnectionHandler): () => void {
    this.disconnectedHandlers.add(callback);

    return () => {
      this.disconnectedHandlers.delete(callback);
    };
  }

  onHostChanged(callback: HostConnectionHandler): () => void {
    this.hostChangedHandlers.add(callback);

    return () => {
      this.hostChangedHandlers.delete(callback);
    };
  }

  // -------------------------------------------------------------------------
  // HOST / TOPOLOGY
  // -------------------------------------------------------------------------

  private recalculateHost(peerIds: string[]): void {
    const uniquePeerIds = [...new Set(peerIds)];

    if (uniquePeerIds.length === 0) {
      return;
    }

    uniquePeerIds.sort();

    const newHostId = uniquePeerIds[0];

    if (this.currentHostId === newHostId) {
      return;
    }

    const previousHostId = this.currentHostId;

    this.currentHostId = newHostId;

    console.log(
      `[WebRTC] Host changed: ${previousHostId ?? "none"} -> ${newHostId}`,
    );

    this.hostChangedHandlers.forEach((callback) => {
      callback(newHostId);
    });
  }

  private async handlePeerJoined(peerId: string): Promise<void> {
    const localPeerId = this.peerId;

    if (!localPeerId) {
      return;
    }

    /*
     * Recalculate using everyone we currently know.
     *
     * Existing connections also give us additional knowledge.
     */
    const knownPeers = new Set<string>([
      localPeerId,
      peerId,
      ...this.connections.keys(),
    ]);

    this.recalculateHost([...knownPeers]);

    await this.reconcileConnections([...knownPeers]);
  }

  private handlePeerLeft(peerId: string): void {
    const wasHost = peerId === this.currentHostId;

    const entry = this.connections.get(peerId);

    if (entry) {
      this.closeConnection(entry);
      this.connections.delete(peerId);
      this.disconnectedHandlers.forEach((callback) => callback(peerId));
    }

    this.pendingSignalsByPeer.delete(peerId);

    if (!wasHost) {
      return;
    }

    /*
     * The current signaling service doesn't expose a complete participant
     * list here, so we can only elect from peers we currently know about.
     *
     * A stronger host-election mechanism should eventually be added to the
     * signaling layer.
     */
    const knownPeers = [
      ...(this.peerId ? [this.peerId] : []),
      ...this.connections.keys(),
    ];

    this.recalculateHost(knownPeers);

    this.reconcileConnections(knownPeers).catch((error) => {
      console.error(
        "[WebRTC] Failed to rebuild topology after host departure",
        error,
      );
    });
  }

  private async reconcileConnections(peerIds: string[]): Promise<void> {
    const localPeerId = this.peerId;
    const hostId = this.currentHostId;

    if (!localPeerId || !hostId) {
      return;
    }

    if (localPeerId === hostId) {
      /*
       * Host connects to every other known participant.
       */
      for (const peerId of peerIds) {
        if (peerId === localPeerId) {
          continue;
        }

        if (this.connections.has(peerId)) {
          continue;
        }

        await this.createConnection(peerId, true);
      }

      return;
    }

    /*
     * Non-host connects ONLY to the host.
     */
    if (!this.connections.has(hostId)) {
      await this.createConnection(hostId, false);
    }

    /*
     * Close connections to anyone who isn't the host.
     */
    for (const [peerId, entry] of this.connections) {
      if (peerId === hostId) {
        continue;
      }

      this.closeConnection(entry);
      this.connections.delete(peerId);
    }
  }

  // -------------------------------------------------------------------------
  // CONNECTION CREATION
  // -------------------------------------------------------------------------

  private async createConnection(
    remotePeerId: string,
    isInitiator: boolean,
  ): Promise<PeerConnectionEntry> {
    const existing = this.connections.get(remotePeerId);

    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    const entry: PeerConnectionEntry = {
      pc,
      channel: null,
      pendingCandidates: [],
      pendingSignals: this.pendingSignalsByPeer.get(remotePeerId) ?? [],
      remoteDescriptionSet: false,
      pendingMessages: [],
    };

    this.pendingSignalsByPeer.delete(remotePeerId);
    this.connections.set(remotePeerId, entry);

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      this.signaling
        .sendSignal(remotePeerId, "candidate", {
          candidate: event.candidate.toJSON(),
        })
        .catch((error) => {
          console.error(
            `[WebRTC] Failed to send ICE candidate to ${remotePeerId}`,
            error,
          );
        });
    };

    pc.onconnectionstatechange = () => {
      console.log(
        `[WebRTC] ${remotePeerId} connection state:`,
        pc.connectionState,
      );

      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.removeConnection(remotePeerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ${remotePeerId} ICE state:`, pc.iceConnectionState);
    };

    if (isInitiator) {
      /*
       * ONLY the host should ever get here with isInitiator=true.
       */
      const channel = pc.createDataChannel(this.dataChannelLabel);

      this.attachDataChannel(remotePeerId, entry, channel);

      const offer = await pc.createOffer();

      await pc.setLocalDescription(offer);

      await this.signaling.sendSignal(remotePeerId, "offer", {
        offer,
      });
    } else {
      /*
       * The non-host waits for the host-created DataChannel.
       */
      pc.ondatachannel = (event) => {
        this.attachDataChannel(remotePeerId, entry, event.channel);
      };
    }

    /*
     * Process signals that arrived before the connection existed.
     */
    const pendingSignals = entry.pendingSignals.splice(0);

    for (const signal of pendingSignals) {
      await this.processSignalForConnection(entry, signal);
    }

    return entry;
  }

  private attachDataChannel(
    peerId: string,
    entry: PeerConnectionEntry,
    channel: RTCDataChannel,
  ): void {
    entry.channel = channel;

    channel.onopen = () => {
      console.log(`[WebRTC] DataChannel opened with ${peerId}`);

      /*
       * Flush messages which were waiting for the connection.
       */
      const pendingMessages = entry.pendingMessages.splice(0);

      for (const message of pendingMessages) {
        try {
          channel.send(message);
        } catch (error) {
          console.error(
            `[WebRTC] Failed to flush queued message to ${peerId}`,
            error,
          );
        }
      }

      this.connectedHandlers.forEach((callback) => callback(peerId));
    };

    channel.onclose = () => {
      this.removeConnection(peerId);
    };

    channel.onerror = (error) => {
      console.error(`[WebRTC] DataChannel error with ${peerId}`, error);
    };

    channel.onmessage = (event) => {
      this.handleIncomingData(peerId, event.data);
    };
  }

  // -------------------------------------------------------------------------
  // SIGNALING
  // -------------------------------------------------------------------------

  private async handleSignal(signal: IncomingSignal): Promise<void> {
    const localPeerId = this.peerId;

    if (!localPeerId) {
      return;
    }

    /*
     * Never process our own signals.
     */
    if (signal.from === localPeerId) {
      return;
    }

    /*
     * An offer is special:
     *
     * - only the host is allowed to create offers
     * - therefore receiving an offer means the sender should be the host
     */
    if (signal.type === "offer" && signal.payload.offer) {
      /*
       * The sender becomes the currently expected host.
       *
       * This is useful when the host has changed.
       */
      if (this.currentHostId !== signal.from) {
        this.currentHostId = signal.from;

        this.hostChangedHandlers.forEach((callback) => callback(signal.from));
      }

      let entry = this.connections.get(signal.from);

      if (!entry) {
        entry = await this.createConnection(signal.from, false);
      }

      await entry.pc.setRemoteDescription(signal.payload.offer);

      entry.remoteDescriptionSet = true;

      await this.flushPendingCandidates(entry);

      const answer = await entry.pc.createAnswer();

      await entry.pc.setLocalDescription(answer);

      await this.signaling.sendSignal(signal.from, "answer", {
        answer,
      });

      return;
    }

    /*
     * Candidates may arrive before the offer.
     */
    if (signal.type === "candidate" && signal.payload.candidate) {
      const entry = this.connections.get(signal.from);

      if (!entry) {
        const pending = this.pendingSignalsByPeer.get(signal.from) ?? [];

        pending.push(signal);

        this.pendingSignalsByPeer.set(signal.from, pending);

        /*
         * The candidate will be processed once the
         * connection is created.
         */
        return;
      }

      if (entry.remoteDescriptionSet) {
        await entry.pc.addIceCandidate(signal.payload.candidate);
      } else {
        entry.pendingCandidates.push(signal.payload.candidate);
      }

      return;
    }

    /*
     * Answers only make sense for a connection which
     * already exists on the host.
     */
    if (signal.type === "answer" && signal.payload.answer) {
      const entry = this.connections.get(signal.from);

      if (!entry) {
        /*
         * Don't discard it. The connection may still be
         * getting created.
         */
        const pending = this.pendingSignalsByPeer.get(signal.from) ?? [];

        pending.push(signal);

        this.pendingSignalsByPeer.set(signal.from, pending);

        return;
      }

      await entry.pc.setRemoteDescription(signal.payload.answer);

      entry.remoteDescriptionSet = true;

      await this.flushPendingCandidates(entry);
    }
  }

  private async processSignalForConnection(
    entry: PeerConnectionEntry,
    signal: IncomingSignal,
  ): Promise<void> {
    if (signal.type === "candidate" && signal.payload.candidate) {
      if (entry.remoteDescriptionSet) {
        await entry.pc.addIceCandidate(signal.payload.candidate);
      } else {
        entry.pendingCandidates.push(signal.payload.candidate);
      }

      return;
    }

    if (signal.type === "offer" && signal.payload.offer) {
      await entry.pc.setRemoteDescription(signal.payload.offer);

      entry.remoteDescriptionSet = true;

      await this.flushPendingCandidates(entry);

      const answer = await entry.pc.createAnswer();

      await entry.pc.setLocalDescription(answer);

      await this.signaling.sendSignal(this.getRemotePeerId(entry), "answer", {
        answer,
      });

      return;
    }

    if (signal.type === "answer" && signal.payload.answer) {
      await entry.pc.setRemoteDescription(signal.payload.answer);

      entry.remoteDescriptionSet = true;

      await this.flushPendingCandidates(entry);
    }
  }

  private async flushPendingCandidates(
    entry: PeerConnectionEntry,
  ): Promise<void> {
    const candidates = entry.pendingCandidates.splice(0);

    for (const candidate of candidates) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch (error) {
        console.error("[WebRTC] Failed to add queued ICE candidate", error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // APPLICATION MESSAGES
  // -------------------------------------------------------------------------

  private handleIncomingData(fromPeerId: string, rawData: unknown): void {
    let message: NetworkMessage;

    try {
      message =
        typeof rawData === "string"
          ? JSON.parse(rawData)
          : (rawData as NetworkMessage);
    } catch {
      console.error("[WebRTC] Received invalid message");
      return;
    }

    if (
      !message ||
      message.type !== "action" ||
      typeof message.id !== "string"
    ) {
      console.error("[WebRTC] Received malformed message");
      return;
    }

    /*
     * Don't process the same message twice.
     */
    if (this.processedMessageIds.has(message.id)) {
      return;
    }

    this.processedMessageIds.add(message.id);

    /*
     * Prevent this Set from growing forever.
     *
     * This is only a safety mechanism for the basic implementation.
     * A production protocol should use sequence numbers / epochs.
     */
    if (this.processedMessageIds.size > 10_000) {
      const first = this.processedMessageIds.values().next().value;

      if (first) {
        this.processedMessageIds.delete(first);
      }
    }

    /*
     * If this is the host:
     *
     *     client -> host
     *
     * Redistribute it to everyone.
     */
    if (this.isHost) {
      this.broadcastNetworkMessage(message);

      /*
       * Deliver locally too.
       */
      this.deliverMessage(message.from, message.data);

      return;
    }

    /*
     * If this is a normal client, messages should only
     * arrive from the host.
     */
    if (fromPeerId !== this.currentHostId) {
      console.warn(
        `[WebRTC] Ignoring application message from non-host ${fromPeerId}`,
      );

      return;
    }

    this.deliverMessage(message.from, message.data);
  }

  private deliverMessage(fromPeerId: string, data: unknown): void {
    this.messageHandlers.forEach((callback) => callback(fromPeerId, data));
  }

  private broadcastNetworkMessage(message: NetworkMessage): void {
    const serialized = JSON.stringify(message);

    for (const [peerId, entry] of this.connections) {
      if (entry.channel?.readyState === "open") {
        try {
          entry.channel.send(serialized);
        } catch (error) {
          console.error(`[WebRTC] Failed to broadcast to ${peerId}`, error);
        }
      }
    }
  }

  private sendRawToPeer(peerId: string, message: NetworkMessage): boolean {
    const entry = this.connections.get(peerId);

    const serialized = JSON.stringify(message);

    if (!entry) {
      return false;
    }

    if (entry.channel?.readyState === "open") {
      try {
        entry.channel.send(serialized);
        return true;
      } catch (error) {
        console.error(`[WebRTC] Failed to send to ${peerId}`, error);

        return false;
      }
    }

    /*
     * Connection exists but DataChannel isn't open yet.
     * Queue the message rather than immediately losing it.
     */
    if (entry.pendingMessages.length < this.maxPendingMessages) {
      entry.pendingMessages.push(serialized);

      return true;
    }

    console.warn(`[WebRTC] Message queue for ${peerId} is full`);

    return false;
  }

  // -------------------------------------------------------------------------
  // CLEANUP
  // -------------------------------------------------------------------------

  private removeConnection(peerId: string): void {
    const entry = this.connections.get(peerId);

    if (!entry) {
      return;
    }

    this.closeConnection(entry);

    this.connections.delete(peerId);

    this.disconnectedHandlers.forEach((callback) => callback(peerId));

    /*
     * If the host's connection died, attempt to
     * rebuild the topology.
     */
    if (peerId === this.currentHostId) {
      const knownPeers = [
        ...(this.peerId ? [this.peerId] : []),
        ...this.connections.keys(),
      ];

      this.recalculateHost(knownPeers);

      this.reconcileConnections(knownPeers).catch((error) => {
        console.error(
          "[WebRTC] Failed to recover after connection loss",
          error,
        );
      });
    }
  }

  private closeConnection(entry: PeerConnectionEntry): void {
    if (entry.channel) {
      entry.channel.onopen = null;
      entry.channel.onclose = null;
      entry.channel.onerror = null;
      entry.channel.onmessage = null;

      try {
        entry.channel.close();
      } catch {
        // Already closed.
      }
    }

    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.ondatachannel = null;

    try {
      entry.pc.close();
    } catch {
      // Already closed.
    }

    entry.pendingCandidates.length = 0;
    entry.pendingSignals.length = 0;
    entry.pendingMessages.length = 0;
  }

  private getRemotePeerId(entry: PeerConnectionEntry): string {
    for (const [peerId, candidate] of this.connections) {
      if (candidate === entry) {
        return peerId;
      }
    }

    throw new Error("Could not determine remote peer ID");
  }
}
