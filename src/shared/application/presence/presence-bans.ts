export const BAN_LIMIT = 100;
export type BanState = readonly string[];

const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 128;

/** Network input. */
export function parseBans(raw: unknown): BanState | undefined {
  return Array.isArray(raw) ? raw.filter(validId).slice(-BAN_LIMIT) : undefined;
}

export function parseBanPayload(raw: unknown): { playerId: string } | undefined {
  const id =
    typeof raw === "object" && raw !== null ? (raw as { playerId?: unknown }).playerId : undefined;
  return validId(id) ? { playerId: id } : undefined;
}

export function addBan(state: BanState, playerId: string): BanState {
  return state.includes(playerId) ? state : [...state, playerId].slice(-BAN_LIMIT);
}

export const isBanned = (state: BanState, playerId: string) => state.includes(playerId);
