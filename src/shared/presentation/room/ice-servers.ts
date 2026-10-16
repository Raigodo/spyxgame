import {
  DEFAULT_CONFIG,
  createConfig,
  isRecord,
  type AppConfig,
  type IceServerConfig,
} from "@/shared/kernel";

/** Network input: keeps well-formed entries, drops the rest. */
export function parseIceServers(raw: unknown): IceServerConfig[] {
  if (!isRecord(raw) || !Array.isArray(raw.iceServers)) return [];
  const result: IceServerConfig[] = [];
  for (const entry of raw.iceServers) {
    if (!isRecord(entry)) continue;
    const urls =
      typeof entry.urls === "string"
        ? [entry.urls]
        : Array.isArray(entry.urls)
          ? entry.urls.filter((u): u is string => typeof u === "string")
          : [];
    if (urls.length === 0) continue;
    result.push({
      urls,
      ...(typeof entry.username === "string" && { username: entry.username }),
      ...(typeof entry.credential === "string" && { credential: entry.credential }),
    });
  }
  return result;
}

/** Relay servers from our own API. Any failure means no extra servers: STUN-only, as before. */
export async function fetchIceServers(): Promise<IceServerConfig[]> {
  try {
    const response = await fetch("/api/turn", {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok ? parseIceServers(await response.json()) : [];
  } catch {
    return [];
  }
}

export function configWithIceServers(extra: readonly IceServerConfig[]): AppConfig {
  return createConfig({
    webrtc: {
      iceServers: extra.length > 0 ? [...extra] : DEFAULT_CONFIG.webrtc.iceServers,
    },
  });
}
