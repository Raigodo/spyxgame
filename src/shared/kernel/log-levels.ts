import type { LogLevel } from "./logger";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export const isLogLevel = (value: string | undefined): value is LogLevel =>
  LOG_LEVELS.some((level) => level === value);

export type ScopeLevels = ReadonlyMap<string, LogLevel>;

/** "bus:debug, webrtc:warn" -> bus=debug, webrtc=warn. Malformed entries are ignored. */
export function parseScopeLevels(raw: string | undefined): ScopeLevels {
  const result = new Map<string, LogLevel>();
  for (const part of (raw ?? "").split(",")) {
    const [scope, level] = part.split(":").map((s) => s.trim());
    if (scope && isLogLevel(level)) result.set(scope, level);
  }
  return result;
}

/** Scopes look like "mp:3F9K2ABC:bus". The last segment that has an override wins. */
export function levelForScope(scope: string, overrides: ScopeLevels, base: LogLevel): LogLevel {
  const segments = scope.split(":");
  for (let i = segments.length - 1; i >= 0; i--) {
    const level = overrides.get(segments[i] ?? "");
    if (level) return level;
  }
  return base;
}
