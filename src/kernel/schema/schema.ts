import { fail, ok, type Result } from "../result";
import { ID_LIMITS, type IdKinds } from "../ids";
import { isRecord } from "../util/guards";

export interface Issue {
  /** Dotted path of the first failure, "" for the root. */
  path: string;
  expected: string;
}

export interface Schema<T> {
  check(input: unknown): Result<T, Issue>;
  /** `check` without the reason. */
  parse(input: unknown): T | undefined;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type Shape = Record<string, Schema<unknown>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ObjectOf<S extends Shape> = Simplify<
  {
    [K in keyof S as S[K] extends OptionalSchema<unknown> ? never : K]: Infer<S[K]>;
  } & {
    [K in keyof S as S[K] extends OptionalSchema<unknown> ? K : never]?: Infer<S[K]>;
  }
>;
type Variants = Record<string, Schema<Record<string, unknown>>>;
type TaggedOf<K extends string, V extends Variants> = {
  [T in keyof V & string]: { [P in K]: T } & Infer<V[T]>;
}[keyof V & string];

// ─── helpers ────────────────────────────────────────────────────────────────

const MAX_JSON_DEPTH = 32;
const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

const bad = (expected: string): Result<never, Issue> => fail({ path: "", expected });

const under = (segment: string | number, issue: Issue): Issue => ({
  path: issue.path ? `${segment}.${issue.path}` : String(segment),
  expected: issue.expected,
});

function make<T>(check: (input: unknown) => Result<T, Issue>): Schema<T> {
  return {
    check,
    parse: (input) => {
      const result = check(input);
      return result.ok ? result.value : undefined;
    },
  };
}

// ─── primitives ─────────────────────────────────────────────────────────────

function string(opts: { max: number; min?: number }): Schema<string> {
  const min = opts.min ?? 0;
  return make((input) =>
    typeof input === "string" && input.length >= min && input.length <= opts.max
      ? ok(input)
      : bad(`string(${min}..${opts.max})`)
  );
}

function int(opts: { min: number; max: number }): Schema<number> {
  return make((input) =>
    typeof input === "number" && Number.isInteger(input) && input >= opts.min && input <= opts.max
      ? ok(input)
      : bad(`int(${opts.min}..${opts.max})`)
  );
}

function number(): Schema<number> {
  return make((input) =>
    typeof input === "number" && Number.isFinite(input) ? ok(input) : bad("number")
  );
}

function boolean(): Schema<boolean> {
  return make((input) => (typeof input === "boolean" ? ok(input) : bad("boolean")));
}

function literal<const L extends readonly (string | number | boolean)[]>(
  ...values: L
): Schema<L[number]> {
  return make((input) =>
    values.some((v) => v === input) ? ok(input as L[number]) : bad(`one of ${values.join("|")}`)
  );
}

function oneOf<const L extends readonly string[]>(options: L): Schema<L[number]> {
  return make((input) =>
    options.some((o) => o === input) ? ok(input as L[number]) : bad(`one of ${options.join("|")}`)
  );
}

function id<K extends keyof IdKinds>(kind: K): Schema<IdKinds[K]> {
  const max = ID_LIMITS[kind];
  return make((input) =>
    typeof input === "string" && input.length >= 1 && input.length <= max
      ? ok(input as IdKinds[K])
      : bad(`${kind} id (1..${max})`)
  );
}

// ─── containers ─────────────────────────────────────────────────────────────

function list<T>(
  item: Schema<T>,
  opts: { max: number; onInvalid: "reject" | "drop" }
): Schema<T[]> {
  return make((input) => {
    if (!Array.isArray(input) || input.length > opts.max) return bad(`list(max ${opts.max})`);
    const out: T[] = [];
    for (const [index, raw] of input.entries()) {
      const result = item.check(raw);
      if (result.ok) out.push(result.value);
      else if (opts.onInvalid === "reject") return fail(under(index, result.reason));
    }
    return ok(out);
  });
}

function record<T>(
  value: Schema<T>,
  opts: { maxKeys: number; onInvalid: "reject" | "drop" }
): Schema<Record<string, T>> {
  return make((input) => {
    if (!isRecord(input)) return bad("record");
    const entries = Object.entries(input);
    if (entries.length > opts.maxKeys) return bad(`record(max ${opts.maxKeys} keys)`);
    const out: Record<string, T> = {};
    for (const [key, raw] of entries) {
      if (key === "__proto__") return bad("record without a __proto__ key");
      const result = value.check(raw);
      if (result.ok) out[key] = result.value;
      else if (opts.onInvalid === "reject") return fail(under(key, result.reason));
    }
    return ok(out);
  });
}

const isOptional = (schema: Schema<unknown>): schema is OptionalSchema<unknown> =>
  (schema as Partial<OptionalSchema<unknown>>).optional === true;

function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  const base = make<T | undefined>((input) =>
    input === undefined ? ok(undefined) : inner.check(input)
  );
  return { ...base, optional: true as const };
}

/** Returns only the declared keys. */
function object<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
  const keys = Object.keys(shape);
  return make((input) => {
    if (!isRecord(input)) return bad("object");
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const field = shape[key] as Schema<unknown>;
      const raw = hasOwn(input, key) ? input[key] : undefined;
      if (raw === undefined && isOptional(field)) continue;
      const result = field.check(raw);
      if (!result.ok) return fail(under(key, result.reason));
      out[key] = result.value;
    }
    return ok(out as unknown as ObjectOf<S>);
  });
}

/** Discriminated union: `tagged("kind", { join: s.object({...}), leave: s.object({...}) })`. */
function tagged<K extends string, V extends Variants>(tag: K, variants: V): Schema<TaggedOf<K, V>> {
  return make((input) => {
    if (!isRecord(input)) return bad("object");
    const kind = input[tag];
    if (typeof kind !== "string" || !hasOwn(variants, kind)) {
      return fail({ path: tag, expected: `one of ${Object.keys(variants).join("|")}` });
    }
    const result = (variants[kind] as Schema<Record<string, unknown>>).check(input);
    if (!result.ok) return fail(result.reason);
    return ok({ ...result.value, [tag]: kind } as unknown as TaggedOf<K, V>);
  });
}

function isJson(v: unknown, depth: number): v is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((item) => isJson(item, depth + 1));
  if (isRecord(v)) {
    return Object.entries(v).every(([key, item]) => key !== "__proto__" && isJson(item, depth + 1));
  }
  return false;
}

/** An opaque JSON payload with a size cap. */
function json(opts: { maxChars: number }): Schema<JsonValue> {
  return make((input) => {
    if (!isJson(input, 0)) return bad("json");
    let size: number;
    try {
      size = JSON.stringify(input).length;
    } catch {
      return bad("json");
    }
    return size <= opts.maxChars ? ok(input) : bad(`json(max ${opts.maxChars} chars)`);
  });
}

function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return make((input) => (input === null ? ok(null) : inner.check(input)));
}

/** For payloads whose shape depends on another field (game slots). */
function custom<T>(fn: (input: unknown) => Result<T, Issue>): Schema<T> {
  return make(fn);
}

export const s = {
  string,
  int,
  number,
  boolean,
  literal,
  oneOf,
  id,
  list,
  record,
  object,
  optional,
  tagged,
  json,
  nullable,
  custom,
};
