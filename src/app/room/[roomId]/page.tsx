// src/app/room/[roomId]/page.tsx   (lobby)
"use client";

import { useState } from "react";
import type { CommandResult } from "@/shared/application/messaging";
import { ChatPanel } from "@/shared/presentation/room/chat-panel";
import {
  useIsHost,
  useLobby,
  usePending,
  usePhase,
  usePlayers,
} from "@/shared/presentation/room/room-hooks";
import { useRoom } from "@/shared/presentation/room/room-provider";
import { demoTap } from "@/demo-tap/demo-tap";

function statusStyles(status: string): string {
  switch (status) {
    case "self":
      return "bg-slate-700 text-slate-200";
    case "active":
      return "bg-emerald-900 text-emerald-300";
    case "connecting":
      return "bg-amber-900 text-amber-300";
    case "reconnecting":
      return "bg-orange-900 text-orange-300";
    default:
      return "bg-slate-700 text-slate-300";
  }
}

export default function LobbyPage() {
  const { client, roomId } = useRoom();
  const phase = usePhase();
  const players = usePlayers();
  const lobby = useLobby();
  const isHost = useIsHost();
  const pending = usePending();

  const [nickname, setNickname] = useState("");
  const [teamIdsInput, setTeamIdsInput] = useState("red,blue");
  const [goalInput, setGoalInput] = useState("20");
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const localPeerId = client.getLocalPeerId();
  const local = players.find((p) => p.peerId === localPeerId);

  function report(result: CommandResult) {
    setNotice(result.ok ? null : `Rejected: ${result.reason}`);
  }

  function chooseTeam(teamId: string) {
    try {
      client.chooseTeam(teamId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't choose team.");
    }
  }

  async function copyInvite() {
    // Deliberately without playerId: every invitee must get their own.
    await navigator.clipboard.writeText(`${window.location.origin}/room/${roomId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // The navigator moves everyone to the game route; this just avoids a flash of lobby.
  if (phase === "in-game") {
    return (
      <div className="bg-slate-950 p-6 min-h-screen text-slate-200">Game in progress, joining…</div>
    );
  }

  return (
    <div className="bg-slate-950 p-6 min-h-screen text-slate-200 text-sm">
      <div className="space-y-6 mx-auto max-w-3xl">
        <header className="flex justify-between items-center">
          <h1 className="font-semibold text-lg">
            Lobby · {roomId} {isHost && <span className="text-indigo-400 text-xs">HOST</span>}
          </h1>
          <button className="px-3 py-1 border border-slate-700 rounded" onClick={copyInvite}>
            {copied ? "Copied!" : "Copy invite link"}
          </button>
        </header>

        {notice && (
          <p className="bg-rose-950 p-2 border border-rose-800 rounded text-rose-300">{notice}</p>
        )}

        <section className="flex flex-wrap items-center gap-2">
          {pending && (
            <p className="bg-amber-950 p-2 border border-amber-800 rounded text-amber-300">
              Reconnecting… your ready state and team will be restored.
            </p>
          )}
          <input
            className="bg-slate-900 px-2 py-1 border border-slate-700 rounded"
            placeholder="Nickname"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
          <button
            className="px-3 py-1 border border-slate-700 rounded"
            onClick={() => client.setNickname(nickname)}
          >
            Set
          </button>
          <button
            disabled={pending}
            className={`rounded px-3 py-1 font-semibold disabled:opacity-40 ${local?.ready ? "bg-emerald-700" : "bg-slate-700"}`}
            onClick={() => client.setReady(!local?.ready)}
          >
            Ready: {local?.ready ? "yes" : "no"}
          </button>
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-500">
              Mode: {lobby.mode}{" "}
              {lobby.allReady && <span className="text-emerald-400">— all ready</span>}
            </span>
            <button
              className="disabled:opacity-40 px-3 py-1 border border-slate-700 rounded"
              disabled={!isHost}
              onClick={() => void client.switchToFreeForAll().then(report)}
            >
              Free-for-all
            </button>
            <input
              className="bg-slate-900 px-2 py-1 border border-slate-700 rounded w-32"
              value={teamIdsInput}
              onChange={(e) => setTeamIdsInput(e.target.value)}
            />
            <button
              className="disabled:opacity-40 px-3 py-1 border border-slate-700 rounded"
              disabled={!isHost}
              onClick={() =>
                void client
                  .switchToTeams(
                    teamIdsInput
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean)
                  )
                  .then(report)
              }
            >
              Teams
            </button>
          </div>

          {lobby.mode === "teams" && (
            <div className="flex flex-wrap gap-2">
              {lobby.teamIds.map((teamId) => (
                <button
                  key={teamId}
                  disabled={pending}
                  className={`rounded px-3 py-1 disabled:opacity-40 ${local?.teamId === teamId ? "bg-indigo-700" : "border border-slate-700"}`}
                  onClick={() => chooseTeam(teamId)}
                >
                  join {teamId}
                </button>
              ))}
              <button
                disabled={pending}
                className="disabled:opacity-40 px-3 py-1 border border-slate-700 rounded"
                onClick={() => client.leaveTeam()}
              >
                leave team
              </button>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-slate-500 text-xs uppercase tracking-wide">
            Players ({players.length})
          </h2>
          <table className="w-full text-xs text-left">
            <thead className="text-slate-500">
              <tr>
                <th>nickname</th>
                <th>ready</th>
                <th>team</th>
                <th>status</th>
                <th>action</th>
              </tr>
            </thead>

            <tbody>
              {players.map((p) => (
                <tr key={p.peerId} className="border-slate-800 border-t">
                  <td className="py-1">
                    {p.nickname}
                    {p.peerId === localPeerId && <span className="text-slate-500"> (you)</span>}
                    {p.peerId === client.getHostPeerId() && (
                      <span className="text-indigo-400"> (host)</span>
                    )}
                  </td>

                  <td>{p.ready ? "✓" : "—"}</td>

                  <td>{p.teamId ?? "—"}</td>

                  <td>
                    <span className={`rounded px-1.5 py-0.5 ${statusStyles(p.connectionStatus)}`}>
                      {p.connectionStatus}
                    </span>
                  </td>

                  <td>
                    {isHost && p.peerId !== localPeerId && p.connectionStatus === "active" && (
                      <button
                        className="px-2 py-0.5 border border-slate-700 rounded text-xs"
                        onClick={() => void client.transferHost(p.peerId).then(report)}
                      >
                        Make host
                      </button>
                    )}
                    {isHost && p.peerId !== localPeerId && (
                      <button
                        className="ml-1 px-2 py-0.5 border border-rose-800 rounded text-rose-300 text-xs"
                        onClick={() => {
                          if (window.confirm(`Remove ${p.nickname} from the room?`)) {
                            void client.kickPlayer(p.peerId).then(report);
                          }
                        }}
                      >
                        Kick
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {isHost ? (
          <div className="flex items-center gap-2">
            <label className="text-slate-500">Goal</label>
            <input
              className="bg-slate-900 px-2 py-1 border border-slate-700 rounded w-20"
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
            />
            <button
              className="bg-emerald-700 hover:bg-emerald-600 px-4 py-2 rounded font-semibold"
              onClick={() =>
                void client.startGame(demoTap, { goal: Number(goalInput) }).then(report)
              }
            >
              Start tap race
            </button>
          </div>
        ) : (
          <p className="text-slate-500">Waiting for the host to start…</p>
        )}

        <ChatPanel />
      </div>
    </div>
  );
}
