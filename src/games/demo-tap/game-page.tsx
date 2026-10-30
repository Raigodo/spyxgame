import { useEffect, useState } from "react";
import { Button } from "@/ui/components/ui/button";
import { useAnnouncement } from "@/ui/game/announcements";
import { Hint, Panel, Problem } from "@/ui/game/panel";
import { useCommand } from "@/ui/use-command";
import { useGame } from "@/ui/use-game";
import { demoTap } from "./definition";
import { standings, teamTotals } from "./view";

const EMOJIS = ["👍", "🎉", "😮"];

export function DemoTapPage() {
  const { handle, view } = useGame(demoTap);
  const { send, error } = useCommand(handle);
  const [emotes, setEmotes] = useState<string[]>([]);

  useEffect(
    () => handle.events.on(({ event }) => setEmotes((list) => [...list.slice(-4), event.emoji])),
    [handle]
  );

  const winner = view?.players.find((p) => p.id === view.state.winner)?.name;
  useAnnouncement(
    winner && view ? { key: `winner:${view.round}`, title: `${winner} wins!` } : undefined
  );

  if (!view) return <Hint>Syncing…</Hint>;

  const rows = standings(view);
  const totals = teamTotals(view);
  const canTap = view.me.role === "player" && !view.paused && !view.state.winner;

  return (
    <>
      <Panel>
        <p className="text-sm">First to {view.settings.goal} taps wins.</p>
        <Button
          size="lg"
          className="h-24! w-full text-xl!"
          disabled={!canTap}
          onClick={() => void send({ type: "tap" })}
        >
          Tap
        </Button>
        {view.me.role === "spectator" && <Hint>You are watching.</Hint>}
        {error && <Problem>{error}</Problem>}
      </Panel>

      <Panel title="Standings">
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {r.name}
                {r.team && <span className="ml-2 text-xs text-muted-foreground">{r.team}</span>}
                {r.away && <span className="ml-2 text-xs text-muted-foreground">away</span>}
              </span>
              <span className="font-mono tabular-nums">{r.score}</span>
            </li>
          ))}
        </ul>
        {totals && <Hint>{totals.map((t) => `${t.team}: ${t.total}`).join(" · ")}</Hint>}
      </Panel>

      <Panel>
        <div className="flex items-center gap-2">
          {EMOJIS.map((emoji) => (
            <Button
              key={emoji}
              variant="outline"
              onClick={() => handle.broadcast({ type: "emote", emoji })}
            >
              {emoji}
            </Button>
          ))}
          <span className="ml-2 text-lg">{emotes.join(" ")}</span>
        </div>
      </Panel>
    </>
  );
}
