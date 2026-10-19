// Tuning knobs, with a required doc. Defaults live in the owning slice's config.ts; the kernel
// only holds the descriptors. One unit for time: milliseconds.

export interface TimerKnob {
  readonly kind: "timer";
  readonly default: number;
  readonly why: string;
  /** A wrong firing removes a live peer. */
  readonly destructive: boolean;
}
export interface LimitKnob {
  readonly kind: "limit";
  readonly default: number;
  readonly why: string;
}
export interface ValueKnob<T> {
  readonly kind: "value";
  readonly default: T;
  readonly why: string;
}
export type Knob = TimerKnob | LimitKnob | ValueKnob<unknown>;

export const timer = (ms: number, opts: { why: string; destructive?: boolean }): TimerKnob => ({
  kind: "timer",
  default: ms,
  why: opts.why,
  destructive: opts.destructive ?? false,
});

export const limit = (n: number, opts: { why: string }): LimitKnob => ({
  kind: "limit",
  default: n,
  why: opts.why,
});

export const value = <T>(initial: T, why: string): ValueKnob<T> => ({
  kind: "value",
  default: initial,
  why,
});

type DefaultsOf<K extends Record<string, Knob>> = { readonly [P in keyof K]: K[P]["default"] };

export interface ConfigDef<K extends Record<string, Knob> = Record<string, Knob>> {
  readonly name: string;
  readonly knobs: K;
  readonly defaults: DefaultsOf<K>;
}

/** The resolved values of a definition: `type LinkConfig = ConfigValues<typeof linkConfig>`. */
export type ConfigValues<D extends ConfigDef> = D["defaults"];

export type ConfigOverrides<D extends ConfigDef> = {
  [P in keyof D["defaults"]]?: D["defaults"][P];
};

export function defineConfig<K extends Record<string, Knob>>(name: string, knobs: K): ConfigDef<K> {
  const defaults = Object.fromEntries(
    Object.entries(knobs).map(([key, knob]) => [key, knob.default])
  ) as DefaultsOf<K>;
  return { name, knobs, defaults: Object.freeze(defaults) };
}

/** Defaults with overrides applied. An explicit `undefined` override keeps the default. */
export function resolveConfig<D extends ConfigDef>(
  def: D,
  overrides: ConfigOverrides<D> = {}
): ConfigValues<D> {
  const out: Record<string, unknown> = { ...def.defaults };
  for (const [key, override] of Object.entries(overrides)) {
    if (override !== undefined && key in def.knobs) out[key] = override;
  }
  return out as unknown as ConfigValues<D>;
}
