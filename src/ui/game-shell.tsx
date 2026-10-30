import type { ReactNode } from "react";
import { toast } from "sonner";
import type { GameModule } from "@/games/module";
import { Button } from "@/ui/components/ui/button";
import { AnnouncementProvider } from "./game/announcements";
import { HeaderSlot } from "./shell/header-slot";
import { useGame } from "./use-game";
import { useStore } from "./use-store";

/**
 * Around one game's page: its title and End button in the header, the pause banner, and the
 * announcement dialog. Host actions stay disabled until the room is synced.
 */
export function GameShell({ mod, children }: { mod: GameModule; children: ReactNode }) {
  const { room, handle, view } = useGame(mod.def);
  const isHost = useStore(room.role) === "host";
  const ready = useStore(room.sync) === "ready";

  async function end() {
    const result = await room.game.actions.end();
    if (!result.ok) toast.error(`Couldn't end the game: ${result.reason.replaceAll("-", " ")}`);
  }
  async function resume() {
    const result = await handle.continueAnyway();
    if (!result.ok) toast.error(`Couldn't continue: ${result.reason.replaceAll("-", " ")}`);
  }

  return (
    <AnnouncementProvider
      actions={
        isHost && (
          <Button disabled={!ready} onClick={() => void end()}>
            Back to lobby
          </Button>
        )
      }
    >
      <HeaderSlot>
        <span className="mr-auto truncate text-sm font-medium">{mod.label}</span>
        {isHost && (
          <Button variant="destructive" size="sm" disabled={!ready} onClick={() => void end()}>
            End game
          </Button>
        )}
      </HeaderSlot>
      {view?.paused && (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted p-3 text-sm">
          <span>Paused: too few players are here.</span>
          {isHost && (
            <Button variant="outline" size="sm" disabled={!ready} onClick={() => void resume()}>
              Continue anyway
            </Button>
          )}
        </div>
      )}
      {children}
    </AnnouncementProvider>
  );
}
