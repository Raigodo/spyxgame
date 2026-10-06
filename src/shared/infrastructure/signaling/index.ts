import { ConsoleLogger, DEFAULT_CONFIG, SystemClock, UlidIdGenerator } from "@/shared/kernel";
import { FirestoreHostElectionAdapter } from "./adapters/firestore/firestore-host-election-adapter";
import { firestoreClient } from "./adapters/firestore/firestore-client";
import { FirestoreRoomMembershipAdapter } from "./adapters/firestore/firestore-room-membership-adapter";
import { FirestoreSignalInboxAdapter } from "./adapters/firestore/firestore-signal-inbox-adapter";
import { SignalingSession, type SignalingSessionDeps } from "./signaling-session";

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
  return new SignalingSession({
    membership: new FirestoreRoomMembershipAdapter(firestoreClient, logger.child("membership")),
    messages: new FirestoreSignalInboxAdapter(firestoreClient),
    election: new FirestoreHostElectionAdapter(firestoreClient),
    config: DEFAULT_CONFIG.signaling,
    ...overrides,
    clock,
    ids: overrides.ids ?? new UlidIdGenerator(clock),
    logger,
  });
}
