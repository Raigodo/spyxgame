"use client";

import { findModule } from "@/games/modules";
import { GameShell } from "./game-shell";
import { HeaderSlot } from "./shell/header-slot";

export function GameScreen({ gameId }: { gameId: string }) {
  const mod = findModule(gameId);
  if (!mod) {
    return (
      <>
        <HeaderSlot>
          <span className="mr-auto truncate text-sm font-medium">Unknown game</span>
        </HeaderSlot>
        <p>No game called “{gameId}”.</p>
      </>
    );
  }
  return (
    <GameShell mod={mod}>
      <mod.Page />
    </GameShell>
  );
}
