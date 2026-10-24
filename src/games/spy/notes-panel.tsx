import type { GameHandle, GameView } from "@/game";
import { useStore } from "@/ui/use-store";
import { btn, card, heading, input } from "@/ui/styles";
import { nextMark, spyNotes } from "./notes";
import type { SpyTypes } from "./schemas";

/** Device-only notes (handle.local): never sent, kept per round. */
export function NotesPanel({
  view,
  handle,
}: {
  view: GameView<SpyTypes>;
  handle: GameHandle<SpyTypes>;
}) {
  const notes = handle.local(spyNotes);
  const value = useStore(notes.value);
  const others = view.players.filter((p) => p.role === "player" && p.id !== view.me.playerId);
  return (
    <section className={card}>
      <h2 className={heading}>My notes (only on this device)</h2>
      <div className="flex flex-wrap gap-2">
        {others.map((p) => (
          <button
            key={p.id}
            className={btn}
            onClick={() =>
              notes.set({
                ...value,
                marks: { ...value.marks, [p.id]: nextMark(value.marks[p.id]) },
              })
            }
          >
            {p.name}: {value.marks[p.id] ?? "unknown"}
          </button>
        ))}
      </div>
      <textarea
        className={`${input} h-24 w-full`}
        value={value.pad}
        onChange={(e) => notes.set({ ...value, pad: e.target.value })}
      />
    </section>
  );
}
