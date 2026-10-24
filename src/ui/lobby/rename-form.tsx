import { useState } from "react";
import { useRoom } from "../room-context";
import { btn, card, errorText, heading, input } from "../styles";
import { useStore } from "../use-store";

export function RenameForm() {
  const room = useRoom();
  const me = useStore(room.roster.state.me);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (draft === null) return;
    const result = await room.roster.actions.rename(draft);
    setError(result.ok ? null : result.reason);
    if (result.ok) setDraft(null);
  }

  return (
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className={heading}>Your name</label>
      <div className="flex gap-2">
        <input
          className={`${input} flex-1`}
          value={draft ?? me?.name ?? ""}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className={btn} disabled={draft === null}>
          Save
        </button>
      </div>
      {error && <p className={errorText}>{error}</p>}
    </form>
  );
}
