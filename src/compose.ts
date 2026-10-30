import { BrowserPageLifecycle } from "@/adapters/browser-page-lifecycle";
import { ConsoleLogger } from "@/adapters/console-logger";
import { CookieStorageAdapter } from "@/adapters/cookie-storage-adapter";
import { CryptoEntropy } from "@/adapters/crypto-entropy";
import { LocalStorageAdapter } from "@/adapters/local-storage-adapter";
import { SessionStorageAdapter } from "@/adapters/session-storage-adapter";
import { SystemClock } from "@/adapters/system-clock";
import { TurnIceServerSource } from "@/adapters/turn-ice-server-source";
import { UlidIdGenerator } from "@/adapters/ulid-id-generator";
import type { KeyValueStore } from "@/kernel";
import { GAME_DEFS } from "@/games/definitions";
import { DEFAULT_ROOM_CONFIG, type RoomDeps } from "@/room";
import { BrowserRtcConnectionProvider } from "@/transport/link/adapters/browser/browser-rtc-connection-provider";
import { getFirestoreClient } from "@/transport/signaling/adapters/firestore/firestore-client";
import { FirestoreHostElectionAdapter } from "@/transport/signaling/adapters/firestore/firestore-host-election-adapter";
import { FirestoreRoomMembershipAdapter } from "@/transport/signaling/adapters/firestore/firestore-room-membership-adapter";
import { FirestoreSignalInboxAdapter } from "@/transport/signaling/adapters/firestore/firestore-signal-inbox-adapter";

let profileStorage: KeyValueStore | undefined;
/** The remembered-nickname storage alone, so the landing page needs no Firebase environment. */
export const getProfileStorage = (): KeyValueStore =>
  (profileStorage ??= new CookieStorageAdapter());

export function createRoomDeps(): RoomDeps {
  const clock = new SystemClock();
  const log = new ConsoleLogger("mp");
  const config = DEFAULT_ROOM_CONFIG;
  const firestore = getFirestoreClient();
  const retention = { clock, config: config.signaling };
  const fsLog = log.child("firestore");
  return {
    clock,
    ids: new UlidIdGenerator(clock),
    log,
    storages: {
      tab: new SessionStorageAdapter(),
      profile: getProfileStorage(),
      device: new LocalStorageAdapter(clock),
    },
    pageLifecycle: new BrowserPageLifecycle(),
    membership: new FirestoreRoomMembershipAdapter(firestore, fsLog, retention),
    inbox: new FirestoreSignalInboxAdapter(firestore, fsLog, retention),
    election: new FirestoreHostElectionAdapter(firestore, fsLog, retention),
    connections: new BrowserRtcConnectionProvider(),
    iceServers: new TurnIceServerSource(),
    entropy: new CryptoEntropy(),
    games: GAME_DEFS,
    config,
  };
}

let deps: RoomDeps | undefined;
/** Created on first use in the browser, so importing never needs Firebase env. */
export const getRoomDeps = (): RoomDeps => (deps ??= createRoomDeps());
