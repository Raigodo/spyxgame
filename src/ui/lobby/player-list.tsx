import { useState } from "react";
import type { Result } from "@/kernel";
import type { Player } from "@/roster";
import { useRoom } from "../room-context";
import { btn, btnDanger, card, errorText, heading } from "../styles";
import { useStore } from "../use-store";

function PlayerRow({ player, isHost }: { player: Player; isHost: boolean }) {
  const { actions } = useRoom().roster;
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<Result<void, string>>) => {
    const result = await action();
    setError(result.ok ? null : result.reason);
  };
  const manage = isHost && player.presence !== "self";

  return (
    <li className="space-y-1">
      <div className="flex justify-between items-center gap-2">
        <span>
          {player.name}
          {player.isHost && <span className="ml-2 text-emerald-400 text-xs">host</span>}
          <span className="ml-2 text-slate-500 text-xs">
            {player.presence === "self" ? "you" : player.presence}
          </span>
        </span>
        {manage && (
          <span className="flex gap-1">
            {player.peerId !== undefined && (
              <button className={btn} onClick={() => run(() => actions.handOff(player.id))}>
                Make host
              </button>
            )}
            <button className={btn} onClick={() => run(() => actions.kick(player.id))}>
              Kick
            </button>
            <button className={btnDanger} onClick={() => run(() => actions.ban(player.id))}>
              Ban
            </button>
          </span>
        )}
      </div>
      {error && <p className={errorText}>{error}</p>}
    </li>
  );
}

export function PlayerList() {
  const room = useRoom();
  const players = useStore(room.roster.state.players);
  const bans = useStore(room.roster.state.bans);
  const isHost = useStore(room.role) === "host";

  return (
    <section className={card}>
      <h2 className={heading}>Players ({players.length})</h2>
      <ul className="space-y-2">
        {players.map((p) => (
          <PlayerRow key={p.id} player={p} isHost={isHost} />
        ))}
      </ul>
      {isHost && bans.size > 0 && (
        <div className="space-y-1">
          <h3 className={heading}>Banned</h3>
          {[...bans].map((id) => (
            <div key={id} className="flex justify-between items-center">
              <span className="font-mono text-xs">{id}</span>
              <button className={btn} onClick={() => void room.roster.actions.unban(id)}>
                Unban
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
