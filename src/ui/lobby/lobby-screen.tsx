"use client";

import { useRoom } from "../room-context";
import { HeaderSlot } from "../shell/header-slot";
import { useStore } from "../use-store";
import { PlayersList } from "../players/players-list";
import { GameLauncher } from "./game-launcher";
import { RenameForm } from "./rename-form";
import { Section } from "./section";

export function LobbyScreen() {
  const room = useRoom();
  const active = useStore(room.game.state.active);
  return (
    <>
      <HeaderSlot>
        <span className="mr-auto truncate text-sm font-medium">Lobby</span>
      </HeaderSlot>
      {active && !active.supported && (
        <p className="rounded-lg border bg-muted p-3 text-sm">
          A game this version does not know is running. Reload to update.
        </p>
      )}
      <Section title="Players">
        <PlayersList />
      </Section>
      <GameLauncher />
      <RenameForm />
    </>
  );
}
