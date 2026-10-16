// Pure handling of the effects a reducer returns. No ports: the runtime passes in the game's own
// validators and the current time, so a notice is checked like any event payload and a timer
// deadline is stamped from the host's clock.

import {
  MAX_TIMER_ID,
  MAX_TIMER_MS,
  MAX_TIMERS,
  withoutTimer,
  type SlotTimers,
  type TimerPayloadCheck,
} from "./game-timers";

export const MAX_NOTICES = 50;

/** A named, typed moment produced by the replicated state. `seq` increases within a round. */
export interface Notice {
  seq: number;
  name: string;
  data: unknown;
}

interface EffectSlot {
  notices: Notice[];
  noticeSeq: number;
  endRequested: boolean;
  paused: boolean;
  timers: SlotTimers;
}

/** The erased shape of GameEffect, as the runtime sees it. */
export interface RawEffect {
  type: string;
  name?: string;
  data?: unknown;
  id?: string;
  afterMs?: number;
  payload?: unknown;
}

export interface EffectContext {
  /** The host's clock, for timer deadlines. */
  now: number;
  /** The game's event validator (notices). */
  validate(name: string, data: unknown): unknown;
  timerPayload: TimerPayloadCheck;
}

/** What `presence.onChange` returns to also ask for effects and private pieces. Build it with `withEffects`. */
export class WithEffects<S, E, H = unknown> {
  constructor(
    readonly state: S,
    readonly effects: readonly E[],
    readonly privateState?: Readonly<Record<string, H | null>>
  ) {}
}

export function withEffects<S, E, H = unknown>(
  state: S,
  effects: readonly E[],
  privateState?: Readonly<Record<string, H | null>>
): WithEffects<S, E, H> {
  return new WithEffects(state, effects, privateState);
}

const INVALID = { ok: false, reason: "invalid-effect" } as const;

export function applyEffects<T extends EffectSlot>(
  slot: T,
  effects: readonly RawEffect[] | undefined,
  ctx: EffectContext
): { ok: true; slot: T } | { ok: false; reason: string } {
  if (!effects || effects.length === 0) return { ok: true, slot };

  let notices = slot.notices;
  let seq = slot.noticeSeq;
  let end = slot.endRequested;
  let timers = slot.timers;

  for (const effect of effects) {
    switch (effect.type) {
      case "end":
        end = true;
        break;
      case "emit": {
        if (typeof effect.name !== "string") return INVALID;
        const data = ctx.validate(effect.name, effect.data);
        if (data === undefined) return INVALID;
        seq += 1;
        notices = [...notices, { seq, name: effect.name, data }];
        break;
      }
      case "startTimer": {
        const { id, name, afterMs } = effect;
        if (typeof id !== "string" || id.length === 0 || id.length > MAX_TIMER_ID) return INVALID;
        if (typeof name !== "string" || typeof afterMs !== "number") return INVALID;
        if (!Number.isFinite(afterMs) || afterMs < 0 || afterMs > MAX_TIMER_MS) return INVALID;
        const payload = ctx.timerPayload(name, effect.payload);
        if (!payload) return INVALID;
        const ms = Math.round(afterMs);
        timers = {
          ...withoutTimer(timers, id),
          // Started while paused: frozen from the start.
          [id]: {
            name,
            payload: payload.value,
            deadlineAt: ctx.now + ms,
            ...(slot.paused && { frozenMs: ms }),
          },
        };
        break;
      }
      case "cancelTimer":
        if (typeof effect.id !== "string") return INVALID;
        timers = withoutTimer(timers, effect.id);
        break;
      default:
        return INVALID;
    }
  }
  if (Object.keys(timers).length > MAX_TIMERS) return INVALID;

  return {
    ok: true,
    slot: {
      ...slot,
      notices: notices.slice(-MAX_NOTICES),
      noticeSeq: seq,
      endRequested: end,
      timers,
    },
  };
}
