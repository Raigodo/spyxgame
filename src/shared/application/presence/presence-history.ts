import { isRecord } from "@/shared/kernel";

export const HISTORY_LIMIT = 50;
const MAX_ENTRY_JSON = 4_000;

export interface HistoryEntry {
  playerId: string;
  metadata: Record<string, unknown>;
}

/** Departed players' metadata, oldest first, at most HISTORY_LIMIT entries. */
export type HistoryState = readonly HistoryEntry[];

/** Network input: a valid entry or undefined. */
export function parseEntry(raw: unknown): HistoryEntry | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.playerId !== "string" ||
    raw.playerId.length === 0 ||
    raw.playerId.length > 128 ||
    !isRecord(raw.metadata) ||
    JSON.stringify(raw.metadata).length > MAX_ENTRY_JSON
  ) {
    return undefined;
  }
  return { playerId: raw.playerId, metadata: raw.metadata };
}

/** Network input: keeps valid entries, drops the rest, trims to the newest HISTORY_LIMIT. */
export function parseHistory(raw: unknown): HistoryState | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map(parseEntry)
    .filter((e): e is HistoryEntry => e !== undefined)
    .slice(-HISTORY_LIMIT);
}

/** Pure reducer step: the entry becomes the newest, replacing any earlier one for that player. */
export function rememberEntry(state: HistoryState, entry: HistoryEntry): HistoryState {
  return [...state.filter((e) => e.playerId !== entry.playerId), entry].slice(-HISTORY_LIMIT);
}

export function findEntry(state: HistoryState, playerId: string): HistoryEntry | undefined {
  return state.find((e) => e.playerId === playerId);
}

/** The remembered keys the local metadata does not have yet, or undefined if there are none. */
export function missingKeys(
  remembered: Record<string, unknown>,
  local: Record<string, unknown>
): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(remembered)) {
    if (!(key in local)) patch[key] = value;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}
