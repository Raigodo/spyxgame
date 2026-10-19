/**
 * Deep equality for JSON-like values (primitives, arrays, plain objects). Properties whose value
 * is undefined count as absent, as they would after a JSON round trip. Not for cyclic data.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => structurallyEqual(item, b[i]))
    );
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((key) => o[key] !== undefined);
  const leftKeys = keys(left);
  return (
    leftKeys.length === keys(right).length &&
    leftKeys.every((key) => structurallyEqual(left[key], right[key]))
  );
}
