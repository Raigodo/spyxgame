// Pure version rules for a game's replicated state. Network input: never trust it.

import { isInt } from "@/shared/kernel";

export type Migrate = (raw: unknown, fromVersion: number) => unknown;

/** The slot's version, 1 when absent (older host), undefined when invalid or newer than we know. */
export function readStateVersion(raw: unknown, current: number): number | undefined {
  if (raw === undefined) return 1;
  return isInt(raw) && raw >= 1 && raw <= current ? raw : undefined;
}

/** Runs the migration only for an older slot. A throwing migration yields undefined (invalid). */
export function migrateIfOlder(
  raw: unknown,
  from: number,
  current: number,
  migrate: Migrate | undefined
): unknown {
  if (from >= current || !migrate) return raw;
  try {
    return migrate(raw, from);
  } catch {
    return undefined;
  }
}
