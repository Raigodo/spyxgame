// Replaces player-identity-store.ts. playerId is no longer generated or
// owned here — it's supplied from outside (query string, auth, whatever the
// app wires up). This module only remembers per-playerId local preferences
// (nickname today, room for more later) so a returning visitor doesn't have
// to retype their name every time they open the same playerId link.
//
// Backed by cookies on purpose, not localStorage: a fixed 1-day expiry means
// an abandoned playerId cleans itself up with no code to write or run — the
// browser does it. No sliding renewal on read/write — that was a deliberate
// simplification, not an oversight.

export interface LocalPlayerProfile {
  nickname: string;
  [key: string]: unknown;
}

const COOKIE_PREFIX = "player-profile:";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24; // 1 day, fixed

export function loadLocalProfile(playerId: string): LocalPlayerProfile | undefined {
  const raw = readCookie(COOKIE_PREFIX + playerId);
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw)) as LocalPlayerProfile;
  } catch {
    return undefined;
  }
}

export function saveLocalProfile(playerId: string, profile: LocalPlayerProfile): void {
  try {
    const encoded = encodeURIComponent(JSON.stringify(profile));
    document.cookie = `${COOKIE_PREFIX}${playerId}=${encoded}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  } catch {
    // best-effort — nickname just won't persist for this playerId
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined; // SSR guard
  const prefix = `${name}=`;
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(prefix))
    ?.slice(prefix.length);
}
