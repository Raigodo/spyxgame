/** A plain object (arrays are not records). */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
