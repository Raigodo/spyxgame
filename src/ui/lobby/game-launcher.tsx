"use client";

import { useState } from "react";
import { toast } from "sonner";
import { GAME_MODULES } from "@/games/modules";
import { Button } from "@/ui/components/ui/button";
import { useRoom } from "../room-context";
import { useStore } from "../use-store";
import { Section } from "./section";

// Only free-for-all exists in the lobby for now; teams need a lobby mode first.
const PLAYABLE = GAME_MODULES.filter((m) => m.def.modes.includes("free-for-all"));

/** Host: pick a game, set it up, start. Guests: wait. */
export function GameLauncher() {
  const room = useRoom();
  const isHost = useStore(room.role) === "host";
  const ready = useStore(room.sync) === "ready";
  const [selected, setSelected] = useState(PLAYABLE[0]?.def.id);
  const mod = PLAYABLE.find((m) => m.def.id === selected) ?? PLAYABLE[0];

  if (!isHost) {
    return (
      <Section title="Game">
        <p className="px-2 text-sm text-muted-foreground">Waiting for the host to start a game.</p>
      </Section>
    );
  }
  if (!mod) return null;

  return (
    <Section title="Game">
      {PLAYABLE.length > 1 && (
        <div className="flex flex-wrap gap-2 px-2">
          {PLAYABLE.map((m) => (
            <Button
              key={m.def.id}
              size="sm"
              variant={m.def.id === mod.def.id ? "default" : "outline"}
              aria-pressed={m.def.id === mod.def.id}
              onClick={() => setSelected(m.def.id)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      )}
      <div className="px-2">
        <mod.Starter
          key={mod.def.id}
          disabled={!ready}
          start={async (settings) => {
            const result = await room.game.actions.start(mod.def, settings);
            if (!result.ok) toast.error(`Can't start: ${result.reason.replaceAll("-", " ")}`);
            return result;
          }}
        />
      </div>
    </Section>
  );
}
