/** Same shape as RTCIceServer, without DOM types. Add a TURN entry here when STUN is not enough. */
export interface IceServerConfig {
  urls: string | readonly string[];
  username?: string;
  credential?: string;
}

export interface AppConfig {
  signaling: {
    candidateCollectionWindowMs: number;
    positionIntervalMs: number;
    ackTimeoutMs: number;
  };
  webrtc: {
    iceServers: readonly IceServerConfig[];
    offerTimeoutMs: number;
    reconnectTimeoutMs: number;
    reclaimWindowMs: number;
    maxChunkSize: number;
    chunkBufferTtlMs: number;
  };
  bus: {
    commandTtlMs: number;
    recoveryWindowMs: number;
    recoveryMaxMs: number;
    resyncIntervalMs: number;
  };
  presence: {
    pingTimeoutMs: number;
    duplicateRevealTimeoutMs: number;
    helloIntervalMs: number;
    linkWaitMs: number;
  };
  chat: {
    burst: number;
    refillPerSecond: number;
    maxTextLength: number;
    maxHistory: number;
  };
  profile: {
    cookieMaxAgeSeconds: number;
  };
}

export type ConfigOverrides = { [K in keyof AppConfig]?: Partial<AppConfig[K]> };

export const DEFAULT_CONFIG: AppConfig = {
  signaling: {
    candidateCollectionWindowMs: 5_000,
    positionIntervalMs: 5_000,
    ackTimeoutMs: 15_000,
  },
  webrtc: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
    offerTimeoutMs: 5_000,
    reconnectTimeoutMs: 5_000,
    reclaimWindowMs: 10_000,
    maxChunkSize: 12_000,
    chunkBufferTtlMs: 30_000,
  },
  bus: {
    commandTtlMs: 30_000,
    recoveryWindowMs: 3_000,
    recoveryMaxMs: 10_000,
    resyncIntervalMs: 3_000,
  },
  presence: {
    pingTimeoutMs: 2_000,
    duplicateRevealTimeoutMs: 4_000, // was PING_TIMEOUT_MS * 2
    helloIntervalMs: 3_000,
    linkWaitMs: 8_000,
  },
  chat: {
    burst: 10,
    refillPerSecond: 1,
    maxTextLength: 500,
    maxHistory: 200,
  },
  profile: {
    cookieMaxAgeSeconds: 60 * 60 * 24,
  },
};

/** Section-level merge: tests pass e.g. `{ signaling: { positionIntervalMs: 10 } }`. */
export function createConfig(overrides: ConfigOverrides = {}): AppConfig {
  return {
    signaling: { ...DEFAULT_CONFIG.signaling, ...overrides.signaling },
    webrtc: { ...DEFAULT_CONFIG.webrtc, ...overrides.webrtc },
    bus: { ...DEFAULT_CONFIG.bus, ...overrides.bus },
    presence: { ...DEFAULT_CONFIG.presence, ...overrides.presence },
    chat: { ...DEFAULT_CONFIG.chat, ...overrides.chat },
    profile: { ...DEFAULT_CONFIG.profile, ...overrides.profile },
  };
}

// Each class takes only its own section, never the whole AppConfig.
export type SignalingConfig = AppConfig["signaling"];
export type WebRtcConfig = AppConfig["webrtc"];
export type BusConfig = AppConfig["bus"];
export type PresenceConfig = AppConfig["presence"];
export type ChatConfig = AppConfig["chat"];

export type ProfileConfig = AppConfig["profile"];
