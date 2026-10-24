// Slot feature `notices`: the newest notices a reducer emitted, for every peer to read once.
// `seq` increases within a round and is what `GameHandle.noticed` diffs.
// Ported from the `emit` branch of legacy game-effects.ts and parseNotices of game-runtime.ts.

import { fail, isInt, isRecord, ok } from "@/kernel";
import type { RawEffect, Slot, SlotEnv, SlotFeature } from "../model";
import { EFFECT, SLOT_KEY } from "../names";

export type Notice = { seq: number; event: unknown };
export type NoticesX = { seq: number; list: Notice[] };

const INITIAL: NoticesX = { seq: 0, list: [] };

export const noticesOf = (slot: Slot): NoticesX =>
  (slot.x[SLOT_KEY.notices] as NoticesX | undefined) ?? INITIAL;

export const notices: SlotFeature<NoticesX> = {
  key: SLOT_KEY.notices,
  initial: () => INITIAL,

  /** Keeps notices the game's own event schemas accept, drops the rest. */
  parse(raw, _setup, env) {
    if (raw === undefined) return INITIAL;
    if (!isRecord(raw) || !Array.isArray(raw.list)) return undefined;
    if (!isInt(raw.seq) || raw.seq < 0) return undefined;
    const list: Notice[] = [];
    for (const item of raw.list) {
      if (!isRecord(item) || !isInt(item.seq) || item.seq < 1) continue;
      const event = env.runtime.parseEvent(item.event);
      if (event) list.push({ seq: item.seq, event: event.value });
    }
    const kept = list.slice(-env.config.maxNotices);
    return { seq: Math.max(raw.seq, ...kept.map((n) => n.seq)), list: kept };
  },

  effect: {
    types: [EFFECT.emit],
    apply(x: NoticesX, effect: RawEffect, env: SlotEnv) {
      const event = env.runtime.parseEvent(effect.event);
      if (!event) return fail("invalid-effect");
      const seq = x.seq + 1;
      return ok({
        seq,
        list: [...x.list, { seq, event: event.value }].slice(-env.config.maxNotices),
      });
    },
  },
};
