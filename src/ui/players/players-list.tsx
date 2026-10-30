"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { PlayerId, Result } from "@/kernel";
import type { Player } from "@/roster";
import { Button } from "@/ui/components/ui/button";
import { useRoom } from "../room-context";
import { useStore } from "../use-store";

const PRESENCE_LABEL: Record<Player["presence"], string> = {
  self: "you",
  online: "",
  connecting: "connecting",
  reconnecting: "reconnecting",
};

/**
 * Everyone in the room, in join order. The host can tap another player to kick, ban or hand over the
 * host seat. Used in the header popover and in the lobby.
 */
export function PlayersList() {
  const room = useRoom();
  const { actions } = room.roster;
  const players = useStore(room.roster.state.players);
  const bans = useStore(room.roster.state.bans);
  const isHost = useStore(room.role) === "host";
  const ready = useStore(room.sync) === "ready";
  const [open, setOpen] = useState<PlayerId | null>(null);

  async function run(failed: string, action: () => Promise<Result<void, string>>) {
    const result = await action();
    if (result.ok) setOpen(null);
    else toast.error(`${failed}: ${result.reason.replaceAll("-", " ")}`);
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {players.map((p) => {
          const manage = isHost && p.presence !== "self";
          const label = PRESENCE_LABEL[p.presence];
          return (
            <li key={p.id}>
              <button
                type="button"
                disabled={!manage}
                aria-expanded={manage ? open === p.id : undefined}
                onClick={() => setOpen(open === p.id ? null : p.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm enabled:hover:bg-muted"
              >
                <span className="truncate">{p.name}</span>
                {p.isHost && <span className="text-xs text-muted-foreground">host</span>}
                {label && <span className="ml-auto text-xs text-muted-foreground">{label}</span>}
              </button>
              {manage && open === p.id && (
                <div className="flex gap-1 px-2 pb-1">
                  {p.peerId !== undefined && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!ready}
                      onClick={() => void run("Hand-off failed", () => actions.handOff(p.id))}
                    >
                      Make host
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!ready}
                    onClick={() => void run("Kick failed", () => actions.kick(p.id))}
                  >
                    Kick
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!ready}
                    onClick={() => void run("Ban failed", () => actions.ban(p.id))}
                  >
                    Ban
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {isHost && bans.size > 0 && (
        <div className="space-y-1 border-t pt-3">
          <p className="px-2 text-xs text-muted-foreground">Banned</p>
          {[...bans].map((id) => (
            <div key={id} className="flex items-center justify-between gap-2 px-2">
              <span className="truncate font-mono text-xs">{id}</span>
              <Button
                variant="ghost"
                size="xs"
                disabled={!ready}
                onClick={() => void run("Unban failed", () => actions.unban(id))}
              >
                Unban
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
