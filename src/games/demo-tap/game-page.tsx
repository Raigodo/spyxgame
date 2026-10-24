import { useEffect, useState } from "react";
import { useCommand } from "@/ui/use-command";
import { useGame } from "@/ui/use-game";
import { btn, btnPrimary, card, errorText, heading } from "@/ui/styles";
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

  if (!view) return <p className="text-slate-500">Syncing…</p>;

  const rows = standings(view);
  const totals = teamTotals(view);
  const winner = view.players.find((p) => p.id === view.state.winner)?.name;
  const canTap = view.me.role === "player" && !view.paused && !view.state.winner;

  return (
    <>
      <section className={card}>
        <p>First to {view.settings.goal} taps wins.</p>
        {winner && <p className="font-semibold text-emerald-400">{winner} wins!</p>}
        <button
          className={`${btnPrimary} w-full py-6 text-lg`}
          disabled={!canTap}
          onClick={() => void send({ type: "tap" })}
        >
          Tap
        </button>
        {view.me.role === "spectator" && <p className="text-slate-400">You are watching.</p>}
        {error && <p className={errorText}>{error}</p>}
      </section>

      <section className={card}>
        <h2 className={heading}>Standings</h2>
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} className="flex justify-between">
              <span>
                {r.name}
                {r.team && <span className="ml-2 text-slate-500 text-xs">{r.team}</span>}
                {r.away && <span className="ml-2 text-amber-400 text-xs">away</span>}
              </span>
              <span className="font-mono">{r.score}</span>
            </li>
          ))}
        </ul>
        {totals && (
          <p className="text-slate-400">{totals.map((t) => `${t.team}: ${t.total}`).join(" · ")}</p>
        )}
      </section>

      <section className={card}>
        <div className="flex items-center gap-2">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className={btn}
              onClick={() => handle.broadcast({ type: "emote", emoji })}
            >
              {emoji}
            </button>
          ))}
          <span className="ml-2 text-lg">{emotes.join(" ")}</span>
        </div>
      </section>
    </>
  );
}
