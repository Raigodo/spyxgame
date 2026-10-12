"use client";

// A player's private notes panel. Notes live in this browser's localStorage only and are never
// sent to other players. The parent remounts it (via `key`) when the storage key changes.

import { useState } from "react";
import {
  emptyNotes,
  MAX_PAD_LENGTH,
  MAX_REMARK_LENGTH,
  nextMark,
  parseNotes,
  type Mark,
  type SpyNotes,
} from "./spy-notes";

export interface NotesPlayer {
  playerId: string;
  name: string;
}

const MARK_LABEL: Record<Mark, string> = { unknown: "?", suspect: "Suspect", safe: "Safe" };
const MARK_STYLE: Record<Mark, string> = {
  unknown: "border-slate-700 text-slate-400",
  suspect: "border-rose-800 bg-rose-950 text-rose-300",
  safe: "border-emerald-800 bg-emerald-950 text-emerald-300",
};

function load(storageKey: string): SpyNotes {
  try {
    return parseNotes(window.localStorage.getItem(storageKey));
  } catch {
    return emptyNotes();
  }
}

function save(storageKey: string, notes: SpyNotes) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(notes));
  } catch {
    // Storage can be blocked or full. The notes still work for this page load.
  }
}

export function SpyNotesPanel({
  storageKey,
  players,
}: {
  storageKey: string;
  players: readonly NotesPlayer[];
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<SpyNotes>(() => load(storageKey));

  function update(next: SpyNotes) {
    setNotes(next);
    save(storageKey, next);
  }

  return (
    <section className="space-y-2 p-3 border border-slate-800 rounded">
      <button
        className="flex justify-between w-full font-semibold text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span>My notes (only you see these)</span>
        <span className="text-slate-500">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="space-y-3">
          <div className="space-y-1">
            {players.map((p) => {
              const mark = notes.marks[p.playerId] ?? "unknown";
              return (
                <div key={p.playerId} className="flex items-center gap-2">
                  <span className="w-28 truncate">{p.name}</span>
                  <button
                    className={`px-2 py-0.5 border rounded w-20 text-xs ${MARK_STYLE[mark]}`}
                    onClick={() =>
                      update({
                        ...notes,
                        marks: { ...notes.marks, [p.playerId]: nextMark(mark) },
                      })
                    }
                  >
                    {MARK_LABEL[mark]}
                  </button>
                  <input
                    className="flex-1 bg-slate-900 px-2 py-0.5 border border-slate-700 rounded text-xs"
                    placeholder="remark"
                    maxLength={MAX_REMARK_LENGTH}
                    value={notes.remarks[p.playerId] ?? ""}
                    onChange={(e) =>
                      update({
                        ...notes,
                        remarks: { ...notes.remarks, [p.playerId]: e.target.value },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>

          <textarea
            className="bg-slate-900 p-2 border border-slate-700 rounded w-full h-28 text-xs"
            placeholder="Free notes"
            maxLength={MAX_PAD_LENGTH}
            value={notes.pad}
            onChange={(e) => update({ ...notes, pad: e.target.value })}
          />
        </div>
      )}
    </section>
  );
}
