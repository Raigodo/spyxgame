import { isRecord } from "@/shared/kernel";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RtcPeerStatus } from "@/shared/infrastructure/webrtc";

export type PersistedMetadata = Record<string, unknown>;
export type PresenceEntry = { status: RtcPeerStatus; returning: boolean };
export type PresenceMap = Record<SignalingPeerId, PresenceEntry>;

export type PresenceEvent =
  | { t: "status"; presence: PresenceMap }
  | { t: "restore"; metadata: PersistedMetadata }
  | { t: "ping"; nonce: string }
  | { t: "pong"; nonce: string }
  | { t: "rejected" }
  | { t: "duplicate"; playerId: string; oldPeerId: SignalingPeerId; newPeerId: SignalingPeerId }
  | { t: "hello" }
  | { t: "kicked" }
  | { t: "farewell"; playerId: string };

const STATUSES: readonly string[] = ["connecting", "active", "reconnecting"];

// Network input: never trust its shape.
export function parsePresenceEvent(raw: unknown): PresenceEvent | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.t) {
    case "status": {
      if (!isRecord(raw.presence)) return undefined;
      const presence: PresenceMap = {};
      for (const [peerId, entry] of Object.entries(raw.presence)) {
        if (
          isRecord(entry) &&
          typeof entry.status === "string" &&
          STATUSES.includes(entry.status) &&
          typeof entry.returning === "boolean"
        ) {
          presence[peerId] = { status: entry.status as RtcPeerStatus, returning: entry.returning };
        }
      }
      return { t: "status", presence };
    }
    case "restore":
      return isRecord(raw.metadata) ? { t: "restore", metadata: raw.metadata } : undefined;
    case "ping":
      return typeof raw.nonce === "string" ? { t: "ping", nonce: raw.nonce } : undefined;
    case "pong":
      return typeof raw.nonce === "string" ? { t: "pong", nonce: raw.nonce } : undefined;
    case "rejected":
      return { t: "rejected" };
    case "duplicate":
      return typeof raw.playerId === "string" &&
        typeof raw.oldPeerId === "string" &&
        typeof raw.newPeerId === "string"
        ? {
            t: "duplicate",
            playerId: raw.playerId,
            oldPeerId: raw.oldPeerId,
            newPeerId: raw.newPeerId,
          }
        : undefined;
    case "hello":
      return { t: "hello" };
    case "kicked":
      return { t: "kicked" };
    case "farewell":
      return typeof raw.playerId === "string"
        ? { t: "farewell", playerId: raw.playerId }
        : undefined;
    default:
      return undefined;
  }
}
