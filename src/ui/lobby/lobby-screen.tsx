"use client";

import { RoomHeader } from "../room-header";
import { useRoom } from "../room-context";
import { Screen } from "../screen";
import { useStore } from "../use-store";
import { GameLauncher } from "./game-launcher";
import { PlayerList } from "./player-list";
import { RenameForm } from "./rename-form";

export function LobbyScreen() {
  const room = useRoom();
  const active = useStore(room.game.state.active);
  return (
    <Screen>
      <RoomHeader title="Lobby" />
      {active && !active.supported && (
        <p className="p-3 border border-amber-700 rounded text-amber-300">
          A game this version does not know is running. Reload to update.
        </p>
      )}
      <PlayerList />
      <RenameForm />
      <GameLauncher />
    </Screen>
  );
}
