import type { GameHandle, GameView } from "@/game";
import { Button } from "@/ui/components/ui/button";
import { Panel } from "@/ui/game/panel";
import { useStore } from "@/ui/use-store";
import { nextMark, spyNotes } from "./notes";
import type { SpyTypes } from "./schemas";
import { Textarea } from "@/ui/components/ui/textarea";

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
    <Panel title="My notes (only on this device)">
      <div className="flex flex-wrap gap-2">
        {others.map((p) => (
          <Button
            key={p.id}
            variant="outline"
            size="sm"
            onClick={() =>
              notes.set({
                ...value,
                marks: { ...value.marks, [p.id]: nextMark(value.marks[p.id]) },
              })
            }
          >
            {p.name}: {value.marks[p.id] ?? "unknown"}
          </Button>
        ))}
      </div>
      <Textarea
        aria-label="Notes"
        className="h-24"
        value={value.pad}
        onChange={(e) => notes.set({ ...value, pad: e.target.value })}
      />
    </Panel>
  );
}
