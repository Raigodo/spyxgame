"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { loadOrCreateIdentity, saveNickname, PlayerSession } from "@/shared/infrastructure/player";
import type { StoredIdentity } from "@/shared/infrastructure/player";
import { WebRtcService } from "@/shared/infrastructure/webrtc";

import { buildLocalProfileInput } from "@/shared/application/lobby/build-local-profile";
import { LobbyController } from "@/shared/application/lobby/lobby-controller";
import type { TeamLobbyService } from "@/shared/application/lobby/team-lobby-service";
import type { LobbyMode, LobbyPlayer } from "@/shared/application/lobby/types";

// Key duplicated from player-identity-store.ts on purpose, just for this
// harness's "simulate a new device" button. If you use this a lot, consider
// exporting a real `clearStoredIdentity()` from that file instead.
const IDENTITY_STORAGE_KEY = "player-identity";

function short(id: string | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

function statusStyles(status: LobbyPlayer["connectionStatus"]): string {
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

export default function LobbyTestHarness() {
  // ─── Connection form state ────────────────────────────────────────────────
  const [roomId, setRoomId] = useState("");
  const [nicknameInput, setNicknameInput] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  // ─── Live service instances. These are ONLY ever constructed inside the
  // join/leave handlers below (event handlers), never lazily during render —
  // that's the classic mistake ("if (!ref.current) ref.current = new Thing()"
  // read/written straight in the render body, which React explicitly
  // disallows: refs must only be read or written in effects/handlers, not
  // during render). Storing them in useState instead sidesteps the problem
  // entirely, since state is only ever set from handlers/effects too. ───────
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [controller, setController] = useState<LobbyController | null>(null);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);

  // ─── Derived / synced UI state ─────────────────────────────────────────────
  const [mode, setMode] = useState<LobbyMode>("free-for-all");
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [hostPeerId, setHostPeerId] = useState<string | undefined>(undefined);
  const [teamIdsInput, setTeamIdsInput] = useState("red,blue");
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const log = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-49), `${stamp}  ${message}`]);
  }, []);

  // This ref exists only so the unmount-cleanup effect can reach the *latest*
  // session/controller without re-running (and re-subscribing) on every
  // render. It is written exclusively inside a useEffect (i.e. after commit)
  // and read exclusively inside a cleanup callback that fires on unmount —
  // never read or written during the render itself. That's the sanctioned
  // use of a ref for "give me the current value later"; the anti-pattern
  // this avoids is reading/writing `ref.current` synchronously in the
  // component body to lazily build a singleton.
  const liveRef = useRef<{ session: PlayerSession | null; controller: LobbyController | null }>({
    session: null,
    controller: null,
  });
  useEffect(() => {
    liveRef.current = { session, controller };
  }, [session, controller]);

  useEffect(() => {
    return () => {
      liveRef.current.controller?.dispose();
      void liveRef.current.session?.leave();
    };
  }, []);

  // ─── Wire up controller events once per join ───────────────────────────────
  useEffect(() => {
    if (!controller) return;

    const refresh = () => setPlayers(controller.getLobby().getPlayers());
    refresh();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(controller.getMode());

    const lobby = controller.getLobby();
    const unsubMode = controller.onModeChanged((next) => {
      setMode(next.mode);
      log(`Mode changed → ${next.mode}`);
      refresh();
    });
    const unsubJoined = lobby.onPlayerJoined((p) => {
      log(`${p.nickname} joined${p.returning ? " (returning)" : ""} [${short(p.peerId)}]`);
      refresh();
    });
    // Covers ready/nickname/team/connection-status/returning changes alike —
    // LobbyRoster re-projects everyone as "updated" whenever presence data
    // changes, so this one handler is enough to stay in sync.
    const unsubUpdated = lobby.onPlayerUpdated(() => refresh());
    const unsubLeft = lobby.onPlayerLeft((p) => {
      log(`${p.nickname} left [${short(p.peerId)}]`);
      refresh();
    });

    return () => {
      unsubMode();
      unsubJoined();
      unsubUpdated();
      unsubLeft();
    };
  }, [controller, log]);

  // ─── Poll host role/id. PlayerSession has no public onHostChanged, so this
  // is the simplest way to keep that bit of the UI honest for manual testing.
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      setIsHost(session.isHost());
      setHostPeerId(session.getHostPeerId());
    }, 500);
    return () => clearInterval(interval);
  }, [session]);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  async function handleJoin() {
    const trimmedRoom = roomId.trim();
    if (!trimmedRoom) return;

    setJoining(true);
    setJoinError(null);
    try {
      const stored = loadOrCreateIdentity(nicknameInput.trim() || "Player");
      const finalNickname = nicknameInput.trim() || stored.nickname;
      if (finalNickname !== stored.nickname) saveNickname(finalNickname);
      const finalIdentity: StoredIdentity = { ...stored, nickname: finalNickname };

      const newSession = new PlayerSession(new WebRtcService());
      await newSession.join(
        trimmedRoom,
        buildLocalProfileInput(finalIdentity),
        finalIdentity.peerId
      );
      const newController = new LobbyController(newSession);

      setIdentity(finalIdentity);
      setSession(newSession);
      setController(newController);
      log(
        `Joined room "${trimmedRoom}" as ${finalIdentity.nickname} ` +
          `[peerId=${short(finalIdentity.peerId)} playerId=${short(finalIdentity.playerId)}]`
      );
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Failed to join room.");
    } finally {
      setJoining(false);
    }
  }

  async function handleLeave() {
    if (!controller || !session) return;
    controller.dispose();
    await session.leave();
    setController(null);
    setSession(null);
    setIdentity(null);
    setPlayers([]);
    setSnapshot(null);
    log("Left room");
  }

  function handleUpdateNickname() {
    if (!controller || !nicknameInput.trim()) return;
    const nickname = nicknameInput.trim();
    controller.getLobby().setNickname(nickname);
    saveNickname(nickname);
    log(`Nickname → ${nickname}`);
  }

  function handleToggleReady() {
    if (!controller) return;
    const local = controller.getLobby().getLocalPlayer();
    controller.getLobby().setReady(!local?.ready);
    log(`Ready → ${!local?.ready}`);
  }

  function handleSwitchMode(next: "free-for-all" | "teams") {
    if (!controller) return;
    try {
      if (next === "free-for-all") {
        controller.switchToFreeForAll();
      } else {
        const teamIds = teamIdsInput
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        controller.switchToTeams(teamIds);
      }
    } catch (error) {
      log(`⚠ ${error instanceof Error ? error.message : "Failed to switch mode."}`);
    }
  }

  function handleChooseTeam(teamId: string) {
    if (!controller || controller.getMode() !== "teams") return;
    try {
      (controller.getLobby() as TeamLobbyService).chooseTeam(teamId);
      log(`Chose team "${teamId}"`);
    } catch (error) {
      log(`⚠ ${error instanceof Error ? error.message : "Failed to choose team."}`);
    }
  }

  function handleLeaveTeam() {
    if (!controller || controller.getMode() !== "teams") return;
    (controller.getLobby() as TeamLobbyService).leaveTeam();
    log("Left team");
  }

  function handleSnapshot() {
    if (!controller) return;
    setSnapshot(JSON.stringify(controller.getSnapshot(), null, 2));
  }

  function handleForgetIdentity() {
    localStorage.removeItem(IDENTITY_STORAGE_KEY);
    log("Cleared stored identity — next join will look like a brand-new device");
  }

  // ─── Derived values for rendering ──────────────────────────────────────────
  const localPlayer = players.find((p) => p.peerId === session?.getLocalPlayer()?.peerId);
  const teamLobby =
    controller && controller.getMode() === "teams"
      ? (controller.getLobby() as TeamLobbyService)
      : null;
  const allReady = controller ? controller.getLobby().areAllPlayersReady() : false;

  return (
    <div className="bg-slate-950 p-6 min-h-screen font-mono text-slate-200 text-sm">
      <div className="space-y-6 mx-auto max-w-5xl">
        <header>
          <h1 className="font-semibold text-slate-100 text-lg">Lobby Controller Test Harness</h1>
          <p className="mt-1 text-slate-500">
            Open this in a few tabs with the same room id to simulate multiple peers.
          </p>
        </header>

        {/* Connection */}
        <section className="bg-slate-900 p-4 border border-slate-800 rounded">
          {!controller ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-slate-500 text-xs">Room ID</span>
                <input
                  className="bg-slate-950 px-2 py-1 border border-slate-700 focus:border-slate-500 rounded outline-none w-40 text-slate-100"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  placeholder="room-abc"
                />
              </label>
              <button
                className="px-2 py-1 border border-slate-700 hover:border-slate-500 rounded text-slate-400 text-xs"
                onClick={() => setRoomId(crypto.randomUUID().slice(0, 8))}
              >
                random
              </button>
              <label className="flex flex-col gap-1">
                <span className="text-slate-500 text-xs">Nickname</span>
                <input
                  className="bg-slate-950 px-2 py-1 border border-slate-700 focus:border-slate-500 rounded outline-none w-40 text-slate-100"
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  placeholder="Player"
                />
              </label>
              <button
                className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-4 py-1.5 rounded font-semibold text-emerald-50"
                disabled={joining || !roomId.trim()}
                onClick={handleJoin}
              >
                {joining ? "Joining…" : "Join room"}
              </button>
              <button
                className="px-3 py-1.5 border border-slate-700 hover:border-slate-500 rounded text-slate-400 text-xs"
                onClick={handleForgetIdentity}
              >
                Forget stored identity
              </button>
              {joinError && <span className="text-rose-400">{joinError}</span>}
            </div>
          ) : (
            <div className="flex flex-wrap justify-between items-center gap-3">
              <div className="space-y-1">
                <div>
                  Room <span className="text-slate-100">{roomId}</span>
                  {isHost && (
                    <span className="bg-indigo-900 ml-2 px-1.5 py-0.5 rounded text-indigo-300 text-xs">
                      HOST
                    </span>
                  )}
                </div>
                <div className="text-slate-500 text-xs">
                  local peerId={short(session?.getLocalPlayer()?.peerId)} playerId=
                  {short(identity?.playerId)} · host peerId={short(hostPeerId)}
                </div>
              </div>
              <button
                className="bg-rose-900 hover:bg-rose-800 px-4 py-1.5 rounded font-semibold text-rose-100"
                onClick={handleLeave}
              >
                Leave room
              </button>
            </div>
          )}
        </section>

        {controller && (
          <>
            {/* You */}
            <section className="bg-slate-900 p-4 border border-slate-800 rounded">
              <h2 className="mb-3 text-slate-500 text-xs uppercase tracking-wide">You</h2>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  className="bg-slate-950 px-2 py-1 border border-slate-700 focus:border-slate-500 rounded outline-none w-40 text-slate-100"
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  placeholder="New nickname"
                />
                <button
                  className="px-3 py-1 border border-slate-700 hover:border-slate-500 rounded text-xs"
                  onClick={handleUpdateNickname}
                >
                  Update nickname
                </button>
                <button
                  className={`rounded px-3 py-1 text-xs font-semibold ${
                    localPlayer?.ready
                      ? "bg-emerald-700 text-emerald-50 hover:bg-emerald-600"
                      : "bg-slate-700 text-slate-200 hover:bg-slate-600"
                  }`}
                  onClick={handleToggleReady}
                >
                  Ready: {localPlayer?.ready ? "yes" : "no"}
                </button>
                {mode === "teams" && (
                  <span className="text-slate-500 text-xs">
                    team: {localPlayer?.teamId ?? "unassigned"}
                  </span>
                )}
              </div>
            </section>

            {/* Mode & teams */}
            <section className="bg-slate-900 p-4 border border-slate-800 rounded">
              <h2 className="mb-3 text-slate-500 text-xs uppercase tracking-wide">
                Mode ({mode}) {allReady && <span className="text-emerald-400">— all ready</span>}
              </h2>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="disabled:opacity-40 px-3 py-1 border border-slate-700 hover:border-slate-500 rounded text-xs"
                  disabled={!isHost}
                  onClick={() => handleSwitchMode("free-for-all")}
                >
                  Switch: free-for-all
                </button>
                <input
                  className="bg-slate-950 px-2 py-1 border border-slate-700 focus:border-slate-500 rounded outline-none w-32 text-slate-100"
                  value={teamIdsInput}
                  onChange={(e) => setTeamIdsInput(e.target.value)}
                  placeholder="red,blue"
                />
                <button
                  className="disabled:opacity-40 px-3 py-1 border border-slate-700 hover:border-slate-500 rounded text-xs"
                  disabled={!isHost}
                  onClick={() => handleSwitchMode("teams")}
                >
                  Switch: teams
                </button>
                {!isHost && (
                  <span className="text-slate-600 text-xs">only the host can switch mode</span>
                )}
              </div>

              {teamLobby && (
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  {teamLobby.getTeams().map((teamId) => (
                    <button
                      key={teamId}
                      className={`rounded px-3 py-1 text-xs ${
                        localPlayer?.teamId === teamId
                          ? "bg-indigo-700 text-indigo-50"
                          : "border border-slate-700 hover:border-slate-500"
                      }`}
                      onClick={() => handleChooseTeam(teamId)}
                    >
                      join {teamId}
                    </button>
                  ))}
                  <button
                    className="px-3 py-1 border border-slate-700 hover:border-slate-500 rounded text-xs"
                    onClick={handleLeaveTeam}
                  >
                    leave team
                  </button>
                </div>
              )}
            </section>

            {/* Roster */}
            <section className="bg-slate-900 p-4 border border-slate-800 rounded">
              <h2 className="mb-3 text-slate-500 text-xs uppercase tracking-wide">
                Players ({players.length})
              </h2>
              <table className="w-full text-xs text-left">
                <thead className="text-slate-500">
                  <tr>
                    <th className="pr-3 pb-1">nickname</th>
                    <th className="pr-3 pb-1">peerId</th>
                    <th className="pr-3 pb-1">playerId</th>
                    <th className="pr-3 pb-1">ready</th>
                    <th className="pr-3 pb-1">team</th>
                    <th className="pr-3 pb-1">status</th>
                    <th className="pb-1">returning</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p) => (
                    <tr key={p.peerId} className="border-slate-800 border-t">
                      <td className="py-1 pr-3">
                        {p.nickname}
                        {p.peerId === session?.getLocalPlayer()?.peerId && (
                          <span className="text-slate-600"> (you)</span>
                        )}
                        {p.peerId === hostPeerId && (
                          <span className="text-indigo-400"> (host)</span>
                        )}
                      </td>
                      <td className="py-1 pr-3 text-slate-500">{short(p.peerId)}</td>
                      <td className="py-1 pr-3 text-slate-500">{short(p.playerId)}</td>
                      <td className="py-1 pr-3">{p.ready ? "✓" : "—"}</td>
                      <td className="py-1 pr-3">{p.teamId ?? "—"}</td>
                      <td className="py-1 pr-3">
                        <span
                          className={`rounded px-1.5 py-0.5 ${statusStyles(p.connectionStatus)}`}
                        >
                          {p.connectionStatus}
                        </span>
                      </td>
                      <td className="py-1">{p.returning ? "yes" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* Snapshot / handoff */}
            <section className="bg-slate-900 p-4 border border-slate-800 rounded">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-slate-500 text-xs uppercase tracking-wide">
                  Snapshot (lobby → game handoff)
                </h2>
                <button
                  className="px-3 py-1 border border-slate-700 hover:border-slate-500 rounded text-xs"
                  onClick={handleSnapshot}
                >
                  getSnapshot()
                </button>
              </div>
              {snapshot && (
                <pre className="bg-slate-950 p-3 rounded max-h-48 overflow-auto text-slate-400 text-xs">
                  {snapshot}
                </pre>
              )}
            </section>

            {/* Log */}
            <section className="bg-slate-900 p-4 border border-slate-800 rounded">
              <h2 className="mb-3 text-slate-500 text-xs uppercase tracking-wide">Event log</h2>
              <div className="space-y-0.5 h-48 overflow-y-auto text-slate-400 text-xs">
                {logs.map((entry, i) => (
                  <div key={i}>{entry}</div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
