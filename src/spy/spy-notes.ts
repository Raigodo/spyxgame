// A player's private notes. They never leave this browser and are never part of game state.
// Pure shape and parsing only; the panel reads and writes localStorage.

export type Mark = "unknown" | "suspect" | "safe";

export interface SpyNotes {
  /** Free text. */
  pad: string;
  /** playerId -> marker */
  marks: Record<string, Mark>;
  /** playerId -> short remark */
  remarks: Record<string, string>;
}

export const MAX_PAD_LENGTH = 5000;
export const MAX_REMARK_LENGTH = 60;

const MARK_CYCLE: readonly Mark[] = ["unknown", "suspect", "safe"];

export const emptyNotes = (): SpyNotes => ({ pad: "", marks: {}, remarks: {} });

export function nextMark(mark: Mark | undefined): Mark {
  const index = MARK_CYCLE.indexOf(mark ?? "unknown");
  return MARK_CYCLE[(index + 1) % MARK_CYCLE.length] as Mark;
}

/** Notes are the user's own data, but a stale or edited value must not break the page. */
export function parseNotes(json: string | null): SpyNotes {
  if (json === null) return emptyNotes();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyNotes();
  }
  if (typeof raw !== "object" || raw === null) return emptyNotes();
  const { pad, marks, remarks } = raw as Record<string, unknown>;

  const notes = emptyNotes();
  if (typeof pad === "string") notes.pad = pad.slice(0, MAX_PAD_LENGTH);
  for (const [id, mark] of Object.entries(isPlain(marks) ? marks : {})) {
    if (mark === "unknown" || mark === "suspect" || mark === "safe") notes.marks[id] = mark;
  }
  for (const [id, text] of Object.entries(isPlain(remarks) ? remarks : {})) {
    if (typeof text === "string") notes.remarks[id] = text.slice(0, MAX_REMARK_LENGTH);
  }
  return notes;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
