import { useState, type ReactNode } from "react";
import type { GameModule } from "@/games/module";
import { RoomHeader } from "./room-header";
import { Screen } from "./screen";
import { btn, btnDanger, errorText } from "./styles";
import { useGame } from "./use-game";
import { useStore } from "./use-store";

/** Header, end button and pause banner around one game's page. */
export function GameShell({ mod, children }: { mod: GameModule; children: ReactNode }) {
  const { room, handle, view } = useGame(mod.def);
  const isHost = useStore(room.role) === "host";
  const [error, setError] = useState<string | null>(null);

  async function end() {
    const result = await room.game.actions.end();
    setError(result.ok ? null : result.reason);
  }
  async function resume() {
    const result = await handle.continueAnyway();
    setError(result.ok ? null : result.reason);
  }

  return (
    <Screen>
      <RoomHeader title={mod.label}>
        {isHost && (
          <button className={btnDanger} onClick={end}>
            End game
          </button>
        )}
      </RoomHeader>
      {error && <p className={errorText}>{error}</p>}
      {view?.paused && (
        <div className="flex justify-between items-center p-3 border border-amber-700 rounded text-amber-300">
          <span>Paused: too few players are here.</span>
          {isHost && (
            <button className={btn} onClick={resume}>
              Continue anyway
            </button>
          )}
        </div>
      )}
      {children}
    </Screen>
  );
}
