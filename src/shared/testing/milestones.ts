import type { RoomHarness } from "./room-harness";

/** Reads a nested value from a plain-JSON debug snapshot, undefined if any step is missing. */
export function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export type Milestones<K extends string> = Record<K, () => boolean>;

/**
 * Advances fake time in small steps and records, per milestone, the first elapsed time (ms since
 * the call) at which its predicate was true. Resolution is `stepMs`. A milestone that never
 * happens stays undefined.
 */
export async function recordMilestones<K extends string>(
  harness: RoomHarness,
  milestones: Milestones<K>,
  totalMs: number,
  stepMs = 100
): Promise<Partial<Record<K, number>>> {
  const start = harness.clock.now();
  const result: Partial<Record<K, number>> = {};
  const names = Object.keys(milestones) as K[];

  for (let elapsed = 0; elapsed <= totalMs; elapsed += stepMs) {
    for (const name of names) {
      if (result[name] !== undefined) continue;
      if (milestones[name]()) result[name] = harness.clock.now() - start;
    }
    if (names.every((name) => result[name] !== undefined)) break;
    harness.clock.advance(stepMs);
    await harness.settle(2);
  }
  return result;
}
