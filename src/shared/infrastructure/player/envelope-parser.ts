import type { SignalingPeerId } from "../signaling";
import type { PlayerProfile } from "./types";

export type Envelope =
  | { kind: "profile"; profile: PlayerProfile }
  | { kind: "roster"; players: PlayerProfile[] }
  | { kind: "app"; scope: "broadcast"; from: SignalingPeerId; payload: unknown }
  | {
      kind: "app";
      scope: "direct";
      from: SignalingPeerId;
      to: SignalingPeerId;
      payload: unknown;
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseProfile(v: unknown): PlayerProfile | undefined {
  if (
    !isRecord(v) ||
    typeof v.peerId !== "string" ||
    typeof v.nickname !== "string" ||
    !isRecord(v.metadata) ||
    typeof v.updatedAt !== "number" ||
    !Number.isFinite(v.updatedAt)
  ) {
    return undefined;
  }
  return { peerId: v.peerId, nickname: v.nickname, metadata: v.metadata, updatedAt: v.updatedAt };
}

/**
 * Network input: a raw string becomes a well-formed Envelope or undefined. The host stamps the
 * verified sender afterwards, so `from` and `peerId` here are only claims. A roster keeps its
 * valid profiles and drops the rest.
 */
export function parseEnvelope(raw: string): Envelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  switch (value.kind) {
    case "profile": {
      const profile = parseProfile(value.profile);
      return profile ? { kind: "profile", profile } : undefined;
    }
    case "roster": {
      if (!Array.isArray(value.players)) return undefined;
      const players = value.players
        .map(parseProfile)
        .filter((p): p is PlayerProfile => p !== undefined);
      return { kind: "roster", players };
    }
    case "app": {
      if (typeof value.from !== "string") return undefined;
      if (value.scope === "broadcast") {
        return { kind: "app", scope: "broadcast", from: value.from, payload: value.payload };
      }
      if (value.scope === "direct" && typeof value.to === "string") {
        return {
          kind: "app",
          scope: "direct",
          from: value.from,
          to: value.to,
          payload: value.payload,
        };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
