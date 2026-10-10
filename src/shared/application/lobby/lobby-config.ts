import { isRecord } from "@/shared/kernel";
import type { LobbyConfig } from "./types";

/** Network input: a valid LobbyConfig or undefined. */
export function sanitizeLobbyConfig(v: unknown): LobbyConfig | undefined {
  if (!isRecord(v)) return undefined;
  if (v.mode === "free-for-all") return { mode: "free-for-all" };
  if (v.mode === "teams" && Array.isArray(v.teamIds)) {
    const ids = v.teamIds
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= 32);
    const unique = Array.from(new Set(ids));
    if (unique.length >= 2 && unique.length <= 8) return { mode: "teams", teamIds: unique };
  }
  return undefined;
}
