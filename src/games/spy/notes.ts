// A player's private notes. They never leave this device and are never part of game state: the
// page reads and writes them through `handle.local(spyNotes)`. Pure shape here, schema in schemas.ts.

import { defineLocalState } from "@/game";
import { MARKS, notesSchema } from "./schemas";

export type Mark = (typeof MARKS)[number];

export type SpyNotes = {
  /** Free text. */
  pad: string;
  /** playerId -> marker */
  marks: Record<string, Mark>;
  /** playerId -> short remark */
  remarks: Record<string, string>;
};

export const emptyNotes = (): SpyNotes => ({ pad: "", marks: {}, remarks: {} });

export function nextMark(mark: Mark | undefined): Mark {
  const index = MARKS.indexOf(mark ?? "unknown");
  return MARKS[(index + 1) % MARKS.length] as Mark;
}

export const spyNotes = defineLocalState<SpyNotes>({
  id: "notes",
  schema: notesSchema,
  initial: emptyNotes,
});
