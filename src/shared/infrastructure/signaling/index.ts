import { ConsoleLogger, DEFAULT_CONFIG, SystemClock, UlidIdGenerator } from "@/shared/kernel";
import { FirestoreHostElectionAdapter } from "./adapters/firestore/firestore-host-election-adapter";
import { FirestoreRoomMembershipAdapter } from "./adapters/firestore/firestore-room-membership-adapter";
import { FirestoreSignalInboxAdapter } from "./adapters/firestore/firestore-signal-inbox-adapter";
import { SignalingSession, type SignalingSessionDeps } from "./signaling-session";
import { getFirestoreClient } from "./adapters/firestore/firestore-client";

export type * from "./types";
export { SignalingSession } from "./signaling-session";
export type { SignalingSessionDeps } from "./signaling-session";
export { HostElectionService } from "./host-election-service";
export type { HostDocument, HostElectionPort } from "./ports/host-election-port";
export type { RoomMembershipPort } from "./ports/room-membership-port";
export type { SignalInboxPort } from "./ports/signal-inbox-port";

export function createSignalingSession(
  overrides: Partial<SignalingSessionDeps> = {}
): SignalingSession {
  const clock = overrides.clock ?? new SystemClock();
  const logger = overrides.logger ?? new ConsoleLogger("signaling");
  const config = overrides.config ?? DEFAULT_CONFIG.signaling;
  const retention = { clock, config };
  return new SignalingSession({
    membership:
      overrides.membership ??
      new FirestoreRoomMembershipAdapter(
        getFirestoreClient(),
        logger.child("membership"),
        retention
      ),
    messages:
      overrides.messages ??
      new FirestoreSignalInboxAdapter(getFirestoreClient(), logger.child("inbox"), retention),
    election:
      overrides.election ??
      new FirestoreHostElectionAdapter(
        getFirestoreClient(),
        logger.child("election-store"),
        retention
      ),
    config,
    clock,
    ids: overrides.ids ?? new UlidIdGenerator(clock),
    logger,
  });
}
