"use client";

import { findModule } from "@/games/modules";
import { GameShell } from "./game-shell";
import { RoomHeader } from "./room-header";
import { Screen } from "./screen";

export function GameScreen({ gameId }: { gameId: string }) {
  const mod = findModule(gameId);
  if (!mod) {
    return (
      <Screen>
        <RoomHeader title="Unknown game" />
        <p>No game called “{gameId}”.</p>
      </Screen>
    );
  }
  return (
    <GameShell mod={mod}>
      <mod.Page />
    </GameShell>
  );
}
