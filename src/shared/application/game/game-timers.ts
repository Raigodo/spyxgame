// Pure timer rules for a game's replicated slot. No clock, no ports: the runtime passes the time in.

import { isRecord } from "@/shared/kernel";

export const MAX_TIMERS = 20;
export const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
export const MAX_TIMER_ID = 64;

/** `frozenMs` is set while the game is paused: the time left, with `deadlineAt` meaningless. */
export interface SlotTimer {
  name: string;
  payload: unknown;
  /** Epoch ms on the host's clock. */
  deadlineAt: number;
  frozenMs?: number;
}

export type SlotTimers = Record<string, SlotTimer>;

/** Checks a timer payload against the game's handler. undefined: unknown timer or invalid payload. */
export type TimerPayloadCheck = (name: string, raw: unknown) => { value: unknown } | undefined;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Network input: keeps valid timers, drops the rest. Undefined only if the shape is hopeless. */
export function parseTimers(raw: unknown, check: TimerPayloadCheck): SlotTimers | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > MAX_TIMERS) return undefined;
  const timers: SlotTimers = {};
  for (const [id, item] of entries) {
    if (id.length === 0 || id.length > MAX_TIMER_ID) continue;
    if (!isRecord(item) || typeof item.name !== "string" || !finite(item.deadlineAt)) continue;
    const frozen = item.frozenMs;
    if (frozen !== undefined && !(finite(frozen) && frozen >= 0 && frozen <= MAX_TIMER_MS))
      continue;
    const payload = check(item.name, item.payload);
    if (!payload) continue;
    timers[id] = {
      name: item.name,
      payload: payload.value,
      deadlineAt: item.deadlineAt,
      ...(frozen !== undefined && { frozenMs: frozen }),
    };
  }
  return timers;
}

export function withoutTimer(timers: SlotTimers, id: string): SlotTimers {
  const next: SlotTimers = {};
  for (const [key, timer] of Object.entries(timers)) if (key !== id) next[key] = timer;
  return next;
}

/** Freezes running timers while paused and restarts frozen ones on resume. Same slot when nothing changed. */
export function syncTimerPause<T extends { paused: boolean; timers: SlotTimers }>(
  slot: T,
  now: number
): T {
  let changed = false;
  const timers: SlotTimers = {};
  for (const [id, timer] of Object.entries(slot.timers)) {
    if (slot.paused && timer.frozenMs === undefined) {
      timers[id] = { ...timer, frozenMs: Math.max(0, timer.deadlineAt - now) };
      changed = true;
    } else if (!slot.paused && timer.frozenMs !== undefined) {
      const { frozenMs, ...rest } = timer;
      timers[id] = { ...rest, deadlineAt: now + frozenMs };
      changed = true;
    } else {
      timers[id] = timer;
    }
  }
  return changed ? { ...slot, timers } : slot;
}
