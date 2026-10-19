export type Result<T, R> = { ok: true; value: T } | { ok: false; reason: R };

export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok(value?: unknown): Result<unknown, never> {
  return { ok: true, value };
}

export const fail = <R>(reason: R): Result<never, R> => ({ ok: false, reason });
