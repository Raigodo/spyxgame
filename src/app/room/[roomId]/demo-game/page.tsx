"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatPanel } from "@/shared/presentation/room/chat-panel";
import {
  useGameHandle,
  useGameValue,
  useIsHost,
  usePlayers,
} from "@/shared/presentation/room/room-hooks";
import { useRoom } from "@/shared/presentation/room/room-provider";
import { demoTap } from "@/demo-tap/demo-tap";

const EMOJIS = ["👍", "🔥", "😂", "😮"];

interface EmoteLine {
  id: string;
  fromPeerId: string;
  emoji: string;
}

export default function DemoGamePage() {
  const router = useRouter();
  const { client } = useRoom();
  const game = useGameHandle(demoTap);
  const players = usePlayers();
  const isHost = useIsHost();

  // Each value is a stable reference between changes, so these are plain subscriptions.
  const state = useGameValue(game, () => game.getState());
  const config = useGameValue(game, () => game.getConfig());
  const context = useGameValue(game, () => game.getContext());
  const role = useGameValue(game, () => game.getRole());
  const team = useGameValue(game, () => game.getMyTeam());

  const [notice, setNotice] = useState<string | null>(null);
  const [emotes, setEmotes] = useState<EmoteLine[]>([]);

  useEffect(
    () =>
      game.onEvent("emote", (data, from) =>
        setEmotes((prev) => [
          ...prev.slice(-9),
          { id: crypto.randomUUID(), fromPeerId: from, emoji: data.emoji },
        ])
      ),
    [game]
  );

  const nameOfPlayer = (playerId: string) =>
    players.find((p) => p.playerId === playerId)?.nickname ?? playerId.slice(0, 8);
  const nameOfPeer = (peerId: string) =>
    players.find((p) => p.peerId === peerId)?.nickname ?? peerId.slice(0, 8);

  async function tap() {
    const result = await game.sendCommand("tap", {});
    if (!result.ok && result.reason !== "game-over") setNotice(`Rejected: ${result.reason}`);
  }

  // The host has created the room's "in-game" state, but the game's own state arrives a moment later.
  if (!state || !config) {
    return <div className="bg-slate-950 p-6 min-h-screen text-slate-200">Starting game…</div>;
  }

  const scores = Object.entries(state.scores).sort((a, b) => b[1] - a[1]);
  const teamTotals: Record<string, number> = {};
  if (context?.mode === "teams") {
    for (const [playerId, score] of scores) {
      const teamId = context.teams[playerId];
      if (teamId) teamTotals[teamId] = (teamTotals[teamId] ?? 0) + score;
    }
  }

  return (
    <div className="bg-slate-950 p-6 min-h-screen text-slate-200 text-sm">
      <div className="space-y-4 mx-auto max-w-2xl">
        <header className="flex justify-between items-center">
          <div className="space-y-1">
            <h1 className="font-semibold text-lg">Tap race · first to {config.goal}</h1>
            <p className="text-slate-500 text-xs">
              You are {role === "player" ? "playing" : "spectating"}
              {team && <> · team {team}</>}
            </p>
          </div>
          <div className="flex gap-2">
            {isHost && (
              <button
                className="bg-amber-700 px-3 py-1 rounded font-semibold"
                onClick={() => void client.endGame()}
              >
                End game
              </button>
            )}
            <button className="bg-rose-900 px-3 py-1 rounded" onClick={() => router.push("/room")}>
              Leave room
            </button>
          </div>
        </header>

        {notice && (
          <p className="bg-rose-950 p-2 border border-rose-800 rounded text-rose-300">{notice}</p>
        )}

        {state.winner && (
          <p className="bg-emerald-950 p-3 border border-emerald-800 rounded text-emerald-300">
            {nameOfPlayer(state.winner)} wins!
          </p>
        )}

        <section className="flex items-center gap-2">
          <button
            disabled={role !== "player" || !!state.winner}
            className="bg-indigo-700 hover:bg-indigo-600 disabled:opacity-40 px-6 py-3 rounded font-semibold text-lg"
            onClick={() => void tap()}
          >
            TAP
          </button>
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className="px-2 py-1 border border-slate-700 rounded"
              onClick={() => game.broadcastEvent("emote", { emoji })}
            >
              {emoji}
            </button>
          ))}
        </section>

        {isHost && (
          <section className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">Hand host to:</span>
            {players
              .filter(
                (p) => p.peerId !== client.getLocalPeerId() && p.connectionStatus === "active"
              )
              .map((p) => (
                <button
                  key={p.peerId}
                  className="px-2 py-0.5 border border-slate-700 rounded"
                  onClick={() =>
                    void client
                      .transferHost(p.peerId)
                      .then((r) => setNotice(r.ok ? null : `Rejected: ${r.reason}`))
                  }
                >
                  {p.nickname}
                </button>
              ))}
          </section>
        )}

        {emotes.length > 0 && (
          <p className="text-slate-400 text-xs">
            {emotes.map((e) => `${nameOfPeer(e.fromPeerId)} ${e.emoji}`).join("  ·  ")}
          </p>
        )}

        <section className="gap-4 grid grid-cols-2">
          <div>
            <h2 className="mb-1 text-slate-500 text-xs uppercase tracking-wide">Scores</h2>
            {scores.map(([playerId, score]) => (
              <div key={playerId} className="flex justify-between">
                <span>{nameOfPlayer(playerId)}</span>
                <span>{score}</span>
              </div>
            ))}
          </div>
          {context?.mode === "teams" && (
            <div>
              <h2 className="mb-1 text-slate-500 text-xs uppercase tracking-wide">Teams</h2>
              {context.teamIds.map((teamId) => (
                <div key={teamId} className="flex justify-between">
                  <span>{teamId}</span>
                  <span>{teamTotals[teamId] ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <ChatPanel />
      </div>
    </div>
  );
}
