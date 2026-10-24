export interface StoredClaim {
  playerId: string;
  peerId: string;
  /** Set on pagehide: this page is going away (refresh or close). */
  leftAt?: number;
}

/** The hint is stored text, so it is untrusted: anything off returns undefined. */
export function parseClaim(raw: string | undefined): StoredClaim | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<StoredClaim> | null;
    if (!v || typeof v.playerId !== "string" || typeof v.peerId !== "string") return undefined;
    return {
      playerId: v.playerId,
      peerId: v.peerId,
      leftAt: typeof v.leftAt === "number" ? v.leftAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/** True when pagehide fired recently enough that the old page is known to be gone. */
export function confirmedGone(claim: StoredClaim, now: number, maxAgeMs: number): boolean {
  return claim.leftAt !== undefined && now - claim.leftAt <= maxAgeMs;
}
