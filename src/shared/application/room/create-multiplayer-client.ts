import { PlayerSession, createPlayerStores } from "@/shared/infrastructure/player";
import {
  createSignalingSession,
  type HostElectionPort,
  type RoomMembershipPort,
  type SignalInboxPort,
  type SignalingSessionDeps,
} from "@/shared/infrastructure/signaling";
import {
  createChunkedMessenger,
  createWebRtcService,
  type RtcConnectionProvider,
} from "@/shared/infrastructure/webrtc";
import {
  BrowserPageLifecycle,
  ConsoleLogger,
  DEFAULT_CONFIG,
  PageLifecycle,
  SystemClock,
  UlidIdGenerator,
  type AppConfig,
  type Clock,
  type IdGenerator,
  type KeyValueStore,
  type Logger,
} from "@/shared/kernel";
import { MultiplayerClient, type ClientOptions } from "./multiplayer-client";

/** Everything the outside world provides. Omit a field to get the real browser implementation. */
export interface MultiplayerClientOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  config?: AppConfig;
  membership?: RoomMembershipPort;
  messages?: SignalInboxPort;
  election?: HostElectionPort;
  connections?: RtcConnectionProvider;
  /** Per-tab storage (host-claim hint). */
  tabStore?: KeyValueStore;
  /** Longer-lived storage (local profile). */
  profileStore?: KeyValueStore;
  pageLifecycle?: PageLifecycle;
}

export function createMultiplayerClient(
  options: ClientOptions = {},
  overrides: MultiplayerClientOverrides = {}
): MultiplayerClient {
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UlidIdGenerator(clock);
  const logger = overrides.logger ?? new ConsoleLogger("mp");
  const config = overrides.config ?? DEFAULT_CONFIG;

  // Only defined ports are passed on: an explicit `undefined` would replace the real default.
  const signalingPorts: Partial<SignalingSessionDeps> = {
    ...(overrides.membership && { membership: overrides.membership }),
    ...(overrides.messages && { messages: overrides.messages }),
    ...(overrides.election && { election: overrides.election }),
  };

  const createSession = (): PlayerSession => {
    const signaling = createSignalingSession({
      ...signalingPorts,
      clock,
      ids,
      logger: logger.child("signaling"),
      config: config.signaling,
    });
    const rtc = createWebRtcService({
      session: signaling,
      connections: overrides.connections,
      clock,
      ids,
      logger: logger.child("webrtc"),
      config: config.webrtc,
    });
    return new PlayerSession({
      rtc,
      messenger: createChunkedMessenger(rtc, { clock, ids, config: config.webrtc }),
      logger: logger.child("player"),
    });
  };

  const stores = createPlayerStores({
    tabStore: overrides.tabStore,
    profileStore: overrides.profileStore,
    profileConfig: config.profile,
    clock,
  });

  const pageLifecycle = overrides.pageLifecycle ?? new BrowserPageLifecycle();
  return new MultiplayerClient(options, {
    createSession,
    stores,
    ids,
    clock,
    logger,
    config,
    pageLifecycle,
  });
}
