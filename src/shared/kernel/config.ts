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
    maxChunksPerMessage: number;
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
    /** How long a departed player stays visible as "reconnecting". */
    departureGraceMs: number;
  };
  chat: {
    burst: number;
    refillPerSecond: number;
    maxTextLength: number;
    maxHistory: number;
  };
  profile: {
    cookieMaxAgeSeconds: number;
    /** A host-claim stamped by pagehide counts as "old page is gone" for this long. */
    hostClaimMaxAgeMs: number;
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
    maxChunksPerMessage: 256,
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
    duplicateRevealTimeoutMs: 4_000,
    helloIntervalMs: 3_000,
    linkWaitMs: 8_000,
    departureGraceMs: 10_000,
  },
  chat: {
    burst: 30,
    refillPerSecond: 1,
    maxTextLength: 500,
    maxHistory: 200,
  },
  profile: {
    cookieMaxAgeSeconds: 60 * 60 * 24,
    hostClaimMaxAgeMs: 15_000,
  },
};

export function createConfig(overrides: ConfigOverrides = {}): AppConfig {
  const result = {} as AppConfig;
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof AppConfig>) {
    result[key] = { ...DEFAULT_CONFIG[key], ...overrides[key] } as never;
  }
  return result;
}

// Each class takes only its own section, never the whole AppConfig.
export type SignalingConfig = AppConfig["signaling"];
export type WebRtcConfig = AppConfig["webrtc"];
export type BusConfig = AppConfig["bus"];
export type PresenceConfig = AppConfig["presence"];
export type ChatConfig = AppConfig["chat"];
export type ProfileConfig = AppConfig["profile"];
