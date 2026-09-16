import { getApp, getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { FirestoreSignalingGateway } from "./firestore-signaling-gateway";
import { HeartbeatTracker } from "./heartbeaat-tracker";
import { ParticipantTracker } from "./participant-tracker";
import { VisibilityWatcher } from "./visibility-watcheer";
import type {
  IncomingSignal,
  JoinRoomResult,
  SignalPayload,
  SignalType,
} from "./types";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

const HEARTBEAT_INTERVAL_MS = 15_000;
/** How long we'll go without a heartbeat before treating a peer (or ourselves) as gone. ~3 missed beats. */
const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;
/** How often we scan our known peers for staleness while in a room. */
const PRESENCE_CHECK_INTERVAL_MS = 10_000;

function generatePeerId(): string {
  return crypto.randomUUID();
}

/**
 * Public-facing signaling API — the only class consumers (e.g. a WebRTC
 * manager) should import. Wires together:
 *
 * - FirestoreSignalingGateway → all Firestore reads/writes/listeners
 * - ParticipantTracker        → join/leave bookkeeping + staleness checks
 * - HeartbeatTracker          → (x2) sends our heartbeat, and separately
 *                                scans for others' missed heartbeats
 * - VisibilityWatcher         → notices when a backgrounded tab comes back
 *
 * Recovery has three layers:
 * 1. On join, any participant already stale is swept before we decide who
 *    to connect to.
 * 2. While in the room, a periodic scan evicts any tracked peer whose
 *    heartbeat has gone quiet — this covers a peer disappearing while
 *    *we* stay active.
 * 3. If *our own* tab gets backgrounded/paused for long enough that our
 *    own heartbeat stalls, returning to the tab re-registers our presence
 *    under the same room + peer id, resyncs who's actually still there,
 *    and fires `onRejoin` so the WebRTC layer reconnects — this covers
 *    *us* going quiet, not just others.
 *
 * The public surface (joinRoom, leaveRoom, sendSignal, onPeerJoined,
 * onPeerLeft, onSignal) is unchanged; `onRejoin` is additive.
 */
export class FirestoreSignalingService {
  private readonly gateway: FirestoreSignalingGateway;
  private readonly participants = new ParticipantTracker();
  private readonly signalHandlers = new Set<(signal: IncomingSignal) => void>();
  private readonly rejoinHandlers = new Set<(peerIds: string[]) => void>();

  private heartbeat: HeartbeatTracker | null = null;
  private presenceMonitor: HeartbeatTracker | null = null;
  private visibility: VisibilityWatcher | null = null;
  private participantsUnsub: (() => void) | null = null;
  private signalsUnsub: (() => void) | null = null;
  private isResuming = false;

  private roomId: string | null = null;
  private peerId: string | null = null;

  constructor() {
    const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
    this.gateway = new FirestoreSignalingGateway(getFirestore(app));
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  get currentPeerId(): string | null {
    return this.peerId;
  }

  async joinRoom(
    roomId: string,
    peerId: string = generatePeerId(),
  ): Promise<JoinRoomResult> {
    if (this.roomId) {
      throw new Error(
        `Already in room "${this.roomId}". Call leaveRoom() first.`,
      );
    }

    this.roomId = roomId;
    this.peerId = peerId;

    const now = Date.now();
    const allParticipants = await this.gateway.getParticipants(roomId);
    const fresh = allParticipants.filter(
      (p) => p.lastSeenMs === null || now - p.lastSeenMs <= STALE_AFTER_MS,
    );
    const stale = allParticipants.filter(
      (p) => p.lastSeenMs !== null && now - p.lastSeenMs > STALE_AFTER_MS,
    );

    stale.forEach(({ peerId: staleId }) => {
      this.gateway.removeParticipant(roomId, staleId).catch(() => {});
      this.gateway.clearInboxFor(roomId, staleId).catch(() => {});
    });

    this.participants.seed(fresh);
    const existingParticipants = fresh.map((p) => p.peerId);

    await this.gateway.registerParticipant(roomId, peerId);

    this.participants.onLeft((goneId) => {
      this.gateway.clearInboxFor(roomId, goneId).catch(() => {});
    });

    this.participantsUnsub = this.gateway.watchParticipants(roomId, (change) =>
      this.participants.handleChange(peerId, change),
    );

    this.signalsUnsub = this.gateway.watchSignalsFor(
      roomId,
      peerId,
      (signal) => {
        this.signalHandlers.forEach((cb) =>
          cb({ from: signal.from, type: signal.type, payload: signal.payload }),
        );
      },
    );

    this.heartbeat = new HeartbeatTracker(HEARTBEAT_INTERVAL_MS, () => {
      this.gateway.touchParticipant(roomId, peerId).catch(() => {
        /* transient failure — next tick will retry */
      });
    });
    this.heartbeat.start();

    this.presenceMonitor = new HeartbeatTracker(
      PRESENCE_CHECK_INTERVAL_MS,
      () => {
        this.participants.getStalePeers(STALE_AFTER_MS).forEach((staleId) => {
          this.participants.evict(staleId);
          this.gateway.removeParticipant(roomId, staleId).catch(() => {});
        });
      },
    );
    this.presenceMonitor.start();

    this.visibility = new VisibilityWatcher(() => {
      this.handlePageVisible().catch((err) =>
        console.error("Failed to resume after returning to the page", err),
      );
    });
    this.visibility.start();

    return { roomId, peerId, existingParticipants };
  }

  async sendSignal(
    to: string,
    type: SignalType,
    payload: SignalPayload,
  ): Promise<void> {
    if (!this.roomId || !this.peerId) {
      throw new Error("Not in a room. Call joinRoom() first.");
    }
    await this.gateway.sendSignal(this.roomId, {
      from: this.peerId,
      to,
      type,
      payload,
    });
  }

  onPeerJoined(cb: (peerId: string) => void): () => void {
    return this.participants.onJoined(cb);
  }

  onPeerLeft(cb: (peerId: string) => void): () => void {
    return this.participants.onLeft(cb);
  }

  onSignal(cb: (signal: IncomingSignal) => void): () => void {
    this.signalHandlers.add(cb);
    return () => this.signalHandlers.delete(cb);
  }

  /**
   * Fires after we've automatically re-established presence following a
   * paused/backgrounded tab, with the peer ids currently in the room. The
   * WebRTC layer should treat this exactly like a fresh join's
   * `existingParticipants` — reconnect to everyone listed.
   */
  onRejoin(cb: (peerIds: string[]) => void): () => void {
    this.rejoinHandlers.add(cb);
    return () => this.rejoinHandlers.delete(cb);
  }

  async leaveRoom(): Promise<void> {
    if (!this.roomId || !this.peerId) return;

    this.heartbeat?.stop();
    this.heartbeat = null;
    this.presenceMonitor?.stop();
    this.presenceMonitor = null;
    this.visibility?.stop();
    this.visibility = null;

    this.participantsUnsub?.();
    this.signalsUnsub?.();
    this.participantsUnsub = null;
    this.signalsUnsub = null;

    await this.gateway.removeParticipant(this.roomId, this.peerId).catch(() => {
      /* best effort */
    });
    await this.gateway.clearInboxFor(this.roomId, this.peerId).catch(() => {
      /* best effort */
    });

    this.participants.reset();
    this.signalHandlers.clear();
    this.rejoinHandlers.clear();
    this.roomId = null;
    this.peerId = null;
  }

  /**
   * Called when the tab becomes visible again. If our own heartbeat kept
   * ticking normally, this is a no-op. If it stalled past the stale
   * threshold (the tab was actually paused, not just briefly unfocused),
   * we re-register our presence under the same room + peer id, resync
   * who's really still around, and tell the WebRTC layer to reconnect.
   */
  private async handlePageVisible(): Promise<void> {
    if (this.isResuming) return;
    if (!this.roomId || !this.peerId || !this.heartbeat) return;

    const elapsed = this.heartbeat.msSinceLastTick();
    if (elapsed === null || elapsed <= STALE_AFTER_MS) return; // heartbeat kept ticking fine

    this.isResuming = true;
    const roomId = this.roomId;
    const peerId = this.peerId;

    try {
      // Recreates our doc if peers reaped it while we were away, or just
      // refreshes it if it's still there but stale.
      await this.gateway.registerParticipant(roomId, peerId);

      const now = Date.now();
      const others = (await this.gateway.getParticipants(roomId)).filter(
        (p) => p.peerId !== peerId,
      );
      const fresh = others.filter(
        (p) => p.lastSeenMs === null || now - p.lastSeenMs <= STALE_AFTER_MS,
      );
      const stale = others.filter(
        (p) => p.lastSeenMs !== null && now - p.lastSeenMs > STALE_AFTER_MS,
      );

      stale.forEach(({ peerId: staleId }) => {
        this.gateway.removeParticipant(roomId, staleId).catch(() => {});
        this.gateway.clearInboxFor(roomId, staleId).catch(() => {});
      });

      this.participants.reconcile(fresh);

      // We effectively just rejoined — the WebRTC layer should treat this
      // exactly like fresh existingParticipants and reconnect.
      const peerIds = fresh.map((p) => p.peerId);
      this.rejoinHandlers.forEach((cb) => cb(peerIds));
    } finally {
      this.isResuming = false;
    }
  }
}
