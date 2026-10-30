"use client";

import { UsersIcon } from "@phosphor-icons/react";
import { buttonVariants } from "@/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/components/ui/popover";
import { useRoom } from "../room-context";
import { useStore } from "../use-store";
import { PlayersList } from "./players-list";

/** Header button: how many are here, and the list on tap. */
export function PlayersMenu() {
  const room = useRoom();
  const players = useStore(room.roster.state.players);
  const here = players.filter((p) => p.peerId !== undefined).length;

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Players"
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        <UsersIcon />
        {here}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PlayersList />
      </PopoverContent>
    </Popover>
  );
}
