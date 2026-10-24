import { defineConfig, limit, timer, value, type ConfigValues } from "@/kernel";

export interface IceServer {
  urls: string | readonly string[];
  username?: string;
  credential?: string;
}

export const signalingConfig = defineConfig("signaling", {
  candidateCollectionWindowMs: timer(3_000, {
    why: "Allows guests detecting a dead host at different moments to collect election candidates before choosing a winner. Also covers the unstamped reclaim grace before suspected-host removal.",
    destructive: true,
  }),
  positionIntervalMs: timer(1_500, {
    why: "Candidate position delay: candidate n waits n intervals, giving earlier candidates time to confirm.",
  }),
  candidateConfirmWindowMs: timer(700, {
    why: "Allows a candidate to confirm its presence before it can be elected.",
  }),
  ackTimeoutMs: timer(15_000, {
    why: "Maximum wait for a peer to acknowledge its signal inbox. An active data channel vetoes removal.",
    destructive: true,
  }),
  messageRetentionMs: timer(60 * 60 * 1000, {
    why: "Retention period for unconsumed signaling messages before Firestore TTL cleanup.",
  }),
  candidateRetentionMs: timer(60 * 60 * 1000, {
    why: "Retention period for election candidate documents before Firestore TTL cleanup.",
  }),
  roomRetentionMs: timer(7 * 24 * 60 * 60 * 1000, {
    why: "Retention period for abandoned room, membership and host documents before Firestore TTL cleanup. Must exceed the expected lifetime of active sessions.",
    destructive: true,
  }),
});

export const linkConfig = defineConfig("link", {
  iceServers: value<readonly IceServer[]>(
    [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
    "STUN-only fallback servers used when relay credentials are unavailable."
  ),
  iceFetchTimeoutMs: timer(4_000, {
    why: "Maximum wait for relay credentials before proceeding with the STUN-only fallback.",
  }),
  offerTimeoutMs: timer(12_000, {
    why: "Maximum wait for an offer from the host before the peer is suspected of being unresponsive.",
    destructive: true,
  }),
  reconnectTimeoutMs: timer(5_000, {
    why: "Maximum wait for a replacement offer after a guest's link dies before its local entry is dropped.",
  }),
  reclaimWindowMs: timer(10_000, {
    why: "Allows a refreshed host to reclaim its seat while its previous peer still appears present.",
  }),
  byeFlushMs: timer(500, {
    why: "Allows the bye frame to drain before the data channel closes.",
  }),
  hostClaimMaxAgeMs: timer(15_000, {
    why: "Maximum age of a pagehide stamp that can be trusted during host-seat reclamation.",
  }),
  iceBatchWindowMs: timer(300, {
    why: "Collects outgoing ICE candidates into batches to reduce signaling document writes.",
  }),
  iceMaxBatch: limit(20, {
    why: "Maximum number of ICE candidates in one outgoing batch.",
  }),
  probeIdleMs: timer(10_000, {
    why: "Maximum idle period before probing a data channel that remains open.",
    destructive: true,
  }),
  probeTimeoutMs: timer(5_000, {
    why: "Maximum wait for a pong response before the probe is considered failed.",
    destructive: true,
  }),
  disconnectGraceMs: timer(3_000, {
    why: "Allows a transient disconnected state, such as a Wi-Fi or VPN interruption, to recover before the link is considered dead.",
    destructive: true,
  }),
  chunkBufferTtlMs: timer(30_000, {
    why: "Maximum lifetime of an incomplete reassembled message before its partial buffer is discarded.",
  }),
  maxChunkChars: limit(12_000, {
    why: "Maximum size of one data-channel frame in UTF-16 code units.",
  }),
  maxChunksPerMessage: limit(256, {
    why: "Maximum chunks retained for one reassembled message, bounding its memory usage.",
  }),
  maxSdpChars: limit(100_000, {
    why: "Maximum accepted size of an incoming SDP offer or answer.",
  }),
  maxCandidateChars: limit(4_000, {
    why: "Maximum accepted size of one incoming ICE candidate.",
  }),
  maxIceCandidatesPerSignal: limit(50, {
    why: "Maximum number of ICE candidates accepted in one signaling batch.",
  }),
});

export type SignalingConfig = ConfigValues<typeof signalingConfig>;
export type LinkConfig = ConfigValues<typeof linkConfig>;
