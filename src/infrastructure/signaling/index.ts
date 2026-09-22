export * from "./types";
export { SignalingSession } from "./signaling-session";
export { HostElectionService } from "./host-election-service";
export type { HostDocument } from "./host-election-gateway";

import { firestoreClient } from "./firestore-client";
import { HostElectionGateway } from "./host-election-gateway";
import { RoomMembershipGateway } from "./room-membership-gateway";
import { SignalingMessageGateway } from "./signaling-message-gateway";
import { SignalingSession } from "./signaling-session";

export function createSignalingSession(): SignalingSession {
  return new SignalingSession(
    new RoomMembershipGateway(firestoreClient),
    new SignalingMessageGateway(firestoreClient),
    new HostElectionGateway(firestoreClient),
  );
}
