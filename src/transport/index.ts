import type { Clock, IdGenerator, Logger, PageLifecycle, Storages } from "@/kernel";
import type { LinkConfig, SignalingConfig } from "./config";
import type {
  HostElectionPort,
  IceServerSource,
  RoomMembershipPort,
  RtcConnectionProvider,
  SignalInboxPort,
} from "./ports";

export { joinTransport } from "./flow";
export type {
  DropReason,
  HandOffReject,
  JoinError,
  LinkState,
  Member,
  Transport,
  Wire,
} from "./model";
export type {
  HostElectionPort,
  IceServerSource,
  RoomMembershipPort,
  RtcConnectionProvider,
  SignalInboxPort,
} from "./ports";
export { linkConfig, signalingConfig } from "./config";
export type { LinkConfig, SignalingConfig } from "./config";

export interface TransportDeps {
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  storages: Pick<Storages, "tab">;
  pageLifecycle: PageLifecycle;
  membership: RoomMembershipPort;
  inbox: SignalInboxPort;
  election: HostElectionPort;
  connections: RtcConnectionProvider;
  iceServers: IceServerSource;
  config: { signaling: SignalingConfig; link: LinkConfig };
}
