"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DEFAULT_ROSTER_CONFIG } from "@/roster";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { useRoom } from "../room-context";
import { useStore } from "../use-store";

export function RenameForm() {
  const room = useRoom();
  const me = useStore(room.roster.state.me);
  const [draft, setDraft] = useState<string | null>(null);

  async function submit() {
    if (draft === null) return;
    const result = await room.roster.actions.rename(draft);
    if (result.ok) setDraft(null);
    else toast.error(`Couldn't rename: ${result.reason.replaceAll("-", " ")}`);
  }

  return (
    <form
      className="flex items-end gap-2 px-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="flex-1 space-y-1">
        <span className="block text-xs text-muted-foreground">Your name</span>
        <Input
          value={draft ?? me?.name ?? ""}
          maxLength={DEFAULT_ROSTER_CONFIG.maxNameLength}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <Button type="submit" variant="outline" size="lg" disabled={draft === null}>
        Save
      </Button>
    </form>
  );
}
