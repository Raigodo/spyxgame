// The room's public types. Contract: docs/rewrite/zoom-4-roster-client.md.
// Only `roster` is carried for now; lobby, chat and game add their own field in their tasks.

import type {
  Clock,
  IdGenerator,
  Logger,
  PageLifecycle,
  PeerId,
  PlayerId,
  RoomId,
  Storages,
  Store,
} from "@/kernel";
import type { BusSync } from "@/bus";
import type { Roster } from "@/roster";
import type {
  HostElectionPort,
  IceServerSource,
  JoinError,
  RoomMembershipPort,
  RtcConnectionProvider,
  SignalInboxPort,
} from "@/transport";
import type { RoomConfig } from "./config";

export interface RoomEnd {
  /** superseded: another tab took this player. kicked: kicked or banned. full: no seat. */
  reason: "superseded" | "kicked" | "full";
}

export interface Room {
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly self: PeerId;
  readonly role: Store<"guest" | "host">;
  readonly sync: Store<BusSync>;
  /** Set once, then the room has already left. */
  readonly ended: Store<RoomEnd | undefined>;
  readonly roster: Roster;
  /** Idempotent. */
  leave(): Promise<void>;
  /** A snapshot for diagnostics; exempt from the store rule. */
  debug(): Record<string, unknown>;
}

export interface RoomDeps {
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  storages: Pick<Storages, "tab" | "profile">;
  pageLifecycle: PageLifecycle;
  membership: RoomMembershipPort;
  inbox: SignalInboxPort;
  election: HostElectionPort;
  connections: RtcConnectionProvider;
  iceServers: IceServerSource;
  config: RoomConfig;
}

export interface JoinRoomParams {
  roomId: RoomId;
  /** Minted when absent. */
  playerId?: PlayerId;
  nickname?: string;
}

export interface JoinedRoom {
  room: Room;
  /** True when a new playerId was minted. */
  generated: boolean;
}

export type { JoinError };
