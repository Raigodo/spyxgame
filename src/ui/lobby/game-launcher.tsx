import { useState } from "react";
import { GAME_MODULES } from "@/games/modules";
import { useRoom } from "../room-context";
import { card, errorText, heading } from "../styles";
import { useStore } from "../use-store";

export function GameLauncher() {
  const room = useRoom();
  const isHost = useStore(room.role) === "host";
  const sync = useStore(room.sync);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className={card}>
      <h2 className={heading}>Games</h2>
      {!isHost && <p className="text-slate-400">Waiting for the host to start a game.</p>}
      {GAME_MODULES.filter((m) => m.def.modes.includes("free-for-all")).map((mod) => (
        <div key={mod.def.id} className="space-y-2">
          <h3 className="font-semibold">{mod.label}</h3>
          <mod.Starter
            disabled={!isHost || sync !== "ready"}
            start={async (settings) => {
              const result = await room.game.actions.start(mod.def, settings);
              setError(result.ok ? null : result.reason.replaceAll("-", " "));
              return result;
            }}
          />
        </div>
      ))}
      {error && <p className={errorText}>{error}</p>}
    </section>
  );
}
