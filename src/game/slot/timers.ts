// Slot feature `timers`: running timers as data (`deadlineAt` on host time, `frozenMs` while the
// game is paused). Pure; game logic never reads a clock, the framework stamps deadlines.
// Ported from legacy game-timers.ts and the timer branch of game-effects.ts.

import { fail, isRecord, ok, type Result } from "@/kernel";
import type { ObserveResult, ParseEnv, RawEffect, Slot, SlotEnv, SlotFeature } from "../model";
import { EFFECT, SLOT_KEY } from "../names";
import { isPaused } from "./presence";

/** `frozenMs` is set while paused: the time left, with `deadlineAt` meaningless. */
export type TimerEntry = {
  timer: string;
  payload: unknown;
  /** Host time in ms. */
  deadlineAt: number;
  frozenMs?: number;
};

export type TimersX = Record<string, TimerEntry>;

const INITIAL: TimersX = {};

export const timersOf = (slot: Slot): TimersX =>
  (slot.x[SLOT_KEY.timers] as TimersX | undefined) ?? INITIAL;

const withTimers = (slot: Slot, x: TimersX): Slot => ({
  ...slot,
  x: { ...slot.x, [SLOT_KEY.timers]: x },
});

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const validId = (id: unknown, env: ParseEnv): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= env.config.maxTimerIdChars;

/** Network input: keeps valid timers, drops the rest. undefined only if the shape is hopeless. */
export function parseTimers(raw: unknown, env: ParseEnv): TimersX | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > env.config.maxTimers) return undefined;
  const timers: TimersX = {};
  for (const [id, item] of entries) {
    if (!validId(id, env) || !isRecord(item)) continue;
    if (typeof item.timer !== "string" || !finite(item.deadlineAt)) continue;
    const frozen = item.frozenMs;
    if (
      frozen !== undefined &&
      !(finite(frozen) && frozen >= 0 && frozen <= env.config.maxTimerMs)
    ) {
      continue;
    }
    const payload = env.runtime.parseTimerPayload(item.timer, item.payload);
    if (!payload) continue;
    timers[id] = {
      timer: item.timer,
      payload: payload.value,
      deadlineAt: item.deadlineAt,
      ...(frozen !== undefined && { frozenMs: frozen }),
    };
  }
  return timers;
}

export function withoutTimer(x: TimersX, id: string): TimersX {
  const next: TimersX = {};
  for (const [key, timer] of Object.entries(x)) if (key !== id) next[key] = timer;
  return next;
}

/** Freezes running timers while paused and restarts frozen ones on resume. Same `x` when nothing changed. */
export function syncTimerPause(x: TimersX, paused: boolean, now: number): TimersX {
  let changed = false;
  const next: TimersX = {};
  for (const [id, timer] of Object.entries(x)) {
    if (paused && timer.frozenMs === undefined) {
      next[id] = { ...timer, frozenMs: Math.max(0, timer.deadlineAt - now) };
      changed = true;
    } else if (!paused && timer.frozenMs !== undefined) {
      const { frozenMs, ...rest } = timer;
      next[id] = { ...rest, deadlineAt: now + frozenMs };
      changed = true;
    } else {
      next[id] = timer;
    }
  }
  return changed ? next : x;
}

/** Due on the host clock, not frozen, game not paused. */
export function isDue(slot: Slot, id: string, now: number): boolean {
  const timer = timersOf(slot)[id];
  return (
    timer !== undefined &&
    timer.frozenMs === undefined &&
    !isPaused(slot) &&
    timer.deadlineAt <= now
  );
}

export function dueTimers(slot: Slot, now: number): string[] {
  return Object.keys(timersOf(slot)).filter((id) => isDue(slot, id, now));
}

/** The earliest deadline of a running (not frozen) timer. */
export function nextDeadline(slot: Slot): number | undefined {
  let next: number | undefined;
  for (const timer of Object.values(timersOf(slot))) {
    if (timer.frozenMs !== undefined) continue;
    if (next === undefined || timer.deadlineAt < next) next = timer.deadlineAt;
  }
  return next;
}

/** The slot with `id` removed from its timers (a fired timer is consumed in the same commit). */
export function consumeTimer(slot: Slot, id: string): Slot {
  return withTimers(slot, withoutTimer(timersOf(slot), id));
}

/** The pause sync, also used right after `continue`. Same slot when nothing changed. */
export function syncTimers(slot: Slot, now: number): Slot {
  const x = timersOf(slot);
  const next = syncTimerPause(x, isPaused(slot), now);
  return next === x ? slot : withTimers(slot, next);
}

function apply(
  x: TimersX,
  effect: RawEffect,
  env: SlotEnv,
  slot: Slot
): Result<TimersX, "invalid-effect"> {
  if (effect.type === EFFECT.cancelTimer) {
    if (typeof effect.id !== "string") return fail("invalid-effect");
    return ok(withoutTimer(x, effect.id));
  }
  const { id, timer, afterMs } = effect;
  if (!validId(id, env) || typeof timer !== "string" || !finite(afterMs)) {
    return fail("invalid-effect");
  }
  if (afterMs < 0 || afterMs > env.config.maxTimerMs) return fail("invalid-effect");
  const payload = env.runtime.parseTimerPayload(timer, effect.payload);
  if (!payload) return fail("invalid-effect");
  const ms = Math.round(afterMs);
  const next: TimersX = {
    ...withoutTimer(x, id),
    // Started while paused: frozen from the start.
    [id]: {
      timer,
      payload: payload.value,
      deadlineAt: env.now + ms,
      ...(isPaused(slot) && { frozenMs: ms }),
    },
  };
  if (Object.keys(next).length > env.config.maxTimers) return fail("invalid-effect");
  return ok(next);
}

function observe(slot: Slot, _observation: unknown, env: SlotEnv): ObserveResult {
  return { slot: syncTimers(slot, env.now) };
}

export const timers: SlotFeature<TimersX> = {
  key: SLOT_KEY.timers,
  initial: () => INITIAL,
  parse: (raw, _setup, env) => (raw === undefined ? INITIAL : parseTimers(raw, env)),
  effect: { types: [EFFECT.startTimer, EFFECT.cancelTimer], apply },
  observe,
};
