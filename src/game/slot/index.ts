// The ordered list of slot features and the pipeline over it. `observe` runs in list order
// (timers read `paused`, which presence sets). A new capability is one module plus one line here.
// Nothing outside game/ imports this folder.

import type { PrivateWrite } from "@/bus";
import { fail, isRecord, ok, type Result } from "@/kernel";
import type {
  Observation,
  ParseEnv,
  RawEffect,
  Reduction,
  Slot,
  SlotEnv,
  SlotFeature,
  SlotSetup,
  StartPlan,
} from "../model";
import { EFFECT } from "../names";
import { notices } from "./notices";
import { presence } from "./presence";
import { applyPrivatePatches, privatePieces } from "./private";
import { timers } from "./timers";

const erase = <X>(feature: SlotFeature<X>): SlotFeature<unknown> =>
  feature as unknown as SlotFeature<unknown>;

/** Order matters: presence, then timers (they read `paused`), notices, private. */
export const SLOT_FEATURES: readonly SlotFeature<unknown>[] = [
  erase(presence),
  erase(timers),
  erase(notices),
  erase(privatePieces),
];

export function initialX(setup: SlotSetup): Record<string, unknown> {
  const x: Record<string, unknown> = {};
  for (const feature of SLOT_FEATURES) x[feature.key] = feature.initial(setup);
  return x;
}

/** Network input. A missing key defaults, a malformed one rejects the whole slot (undefined). */
export function parseX(
  raw: unknown,
  setup: SlotSetup,
  env: ParseEnv
): Record<string, unknown> | undefined {
  if (raw === undefined) return initialX(setup);
  if (!isRecord(raw)) return undefined;
  const x: Record<string, unknown> = {};
  for (const feature of SLOT_FEATURES) {
    const value = feature.parse(raw[feature.key], setup, env);
    if (value === undefined) return undefined;
    x[feature.key] = value;
  }
  return x;
}

type Applied = { slot: Slot; end: boolean };

/** Routes each effect to the feature that owns its type. `end` is the framework's own. */
export function applyEffects(
  slot: Slot,
  effects: readonly RawEffect[] | undefined,
  env: SlotEnv
): Result<Applied, "invalid-effect"> {
  let current = slot;
  let end = false;
  for (const effect of effects ?? []) {
    if (effect.type === EFFECT.end) {
      end = true;
      continue;
    }
    const owner = SLOT_FEATURES.find((f) => f.effect?.types.includes(effect.type));
    if (!owner?.effect) return fail("invalid-effect");
    const result = owner.effect.apply(current.x[owner.key], effect, env, current);
    if (!result.ok) return result;
    current = { ...current, x: { ...current.x, [owner.key]: result.value } };
  }
  return ok({ slot: current, end });
}

export type Committed = { slot: Slot; writes: PrivateWrite[]; end: boolean };

/** A reducer's result: new state, its effects, its private patches. All or nothing. */
export function applyReduction(
  slot: Slot,
  reduction: Reduction,
  env: SlotEnv
): Result<Committed, "invalid-effect" | "invalid-private"> {
  const effects = applyEffects({ ...slot, state: reduction.state }, reduction.effects, env);
  if (!effects.ok) return effects;
  const pieces = applyPrivatePatches(effects.value.slot, reduction.private, env);
  if (!pieces.ok) return pieces;
  return ok({ slot: pieces.value.slot, writes: pieces.value.writes, end: effects.value.end });
}

/**
 * The host's sync step: every feature's `observe`, in order, each result applied through the same
 * effect and private paths. A result with invalid effects or pieces is ignored as a whole.
 * An `end` effect stops the pipeline; the caller then finishes the game.
 * Returns the same slot when nothing changed.
 */
export function observeAll(slot: Slot, observation: Observation, env: SlotEnv): Committed {
  let current = slot;
  const writes: PrivateWrite[] = [];
  for (const feature of SLOT_FEATURES) {
    if (!feature.observe) continue;
    const result = feature.observe(current, observation, env);
    const effects = applyEffects(result.slot, result.effects, env);
    if (!effects.ok) continue;
    const pieces = applyPrivatePatches(effects.value.slot, result.private, env);
    if (!pieces.ok) continue;
    current = pieces.value.slot;
    writes.push(...pieces.value.writes);
    if (effects.value.end) return { slot: current, writes, end: true };
  }
  return { slot: current, writes, end: false };
}

/** A new slot from a validated start plan, with every feature's initial value and the first private pieces. */
export function createSlot(
  input: {
    runtime: { id: string; version: number };
    plan: StartPlan;
    setup: SlotSetup;
    seed: number;
  },
  env: SlotEnv
): Result<{ slot: Slot; writes: PrivateWrite[] }, "invalid-private"> {
  const base: Slot = {
    gameId: input.runtime.id,
    version: input.runtime.version,
    seed: input.seed,
    settings: input.plan.settings,
    state: input.plan.state,
    setup: input.setup,
    x: initialX(input.setup),
  };
  return applyPrivatePatches(base, input.plan.private, env);
}
