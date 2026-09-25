// LobbyAutoTest.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { WebRtcService } from "@/shared/infrastructure/webrtc";
import { PlayerSession, loadOrCreateIdentity } from "@/shared/infrastructure/player";
import {
  LobbyController,
  TeamLobbyService,
  type Lobby,
  type LobbyPlayer,
} from "@/shared/application/lobby";

const ROOM_ID = "test-room2";
const TEAM_IDS = ["red", "blue"];

interface LogEntry {
  timestamp: string;
  text: string;
}

function short(id: string): string {
  return id.slice(0, 8);
}

export function LobbyAutoTest() {
  const sessionRef = useRef<PlayerSession | null>(null);
  const lobbyRef = useRef<LobbyController | null>(null);

  const [joined, setJoined] = useState(false);
  const [nickname, setNickname] = useState("Player");
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [mode, setMode] = useState<Lobby["mode"]>("free-for-all");
  const [isHost, setIsHost] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  function addLog(text: string) {
    const timestamp = new Date().toLocaleTimeString("en", { hour12: false });
    setLog((prev) => [...prev, { timestamp, text }]);
  }

  function refreshPlayers() {
    const lobby = lobbyRef.current?.getLobby();
    setPlayers(lobby ? lobby.getPlayers() : []);
  }

  function refreshHostFlag() {
    setIsHost(sessionRef.current?.isHost() ?? false);
  }

  async function handleJoin() {
    if (sessionRef.current) return;

    const identity = loadOrCreateIdentity(nickname);
    const session = new PlayerSession(new WebRtcService());
    sessionRef.current = session;

    try {
      await session.join(ROOM_ID, { nickname, metadata: { ready: false } }, identity.peerId);

      const lobby = new LobbyController(session);
      lobbyRef.current = lobby;

      lobby.onModeChanged((current) => {
        addLog(`Lobby mode changed → ${current.mode}`);
        setMode(current.mode);
        refreshPlayers();
      });

      lobby.getLobby().onPlayerJoined((p) => {
        addLog(`Player joined: ${p.nickname} (${short(p.peerId)})`);
        refreshPlayers();
      });

      lobby.getLobby().onPlayerUpdated((p) => {
        addLog(`Player updated: ${p.nickname} ready=${p.ready} team=${p.teamId ?? "-"}`);
        refreshPlayers();
      });

      lobby.getLobby().onPlayerLeft((p) => {
        addLog(`Player left: ${p.nickname} (${short(p.peerId)})`);
        refreshPlayers();
      });

      session.onMessage((payload, from) => {
        addLog(`App message from ${short(from)}: ${JSON.stringify(payload)}`);
      });

      session.onHostChanged?.(() => {
        refreshHostFlag();
      });

      setMode(lobby.getMode());
      setJoined(true);
      refreshPlayers();
      refreshHostFlag();
      addLog(`Joined room="${ROOM_ID}" as "${nickname}" (peerId=${short(identity.peerId)})`);
    } catch (error) {
      sessionRef.current = null;
      lobbyRef.current = null;
      const message = error instanceof Error ? error.message : String(error);
      addLog(`Failed to join: ${message}`);
    }
  }

  async function handleLeave() {
    const session = sessionRef.current;
    if (!session) return;

    try {
      lobbyRef.current?.dispose();
      await session.leave();
    } finally {
      sessionRef.current = null;
      lobbyRef.current = null;
      setJoined(false);
      setPlayers([]);
      addLog("Left room");
    }
  }

  function handleToggleReady() {
    const lobby = lobbyRef.current?.getLobby();
    if (!lobby) return;
    const localReady = lobby.getLocalPlayer()?.ready ?? false;
    lobby.setReady(!localReady);
  }

  function handleChooseTeam(teamId: string) {
    const lobby = lobbyRef.current?.getLobby();
    if (!lobby || lobby.mode !== "teams") return;
    (lobby as TeamLobbyService).chooseTeam(teamId);
  }

  function handleLeaveTeam() {
    const lobby = lobbyRef.current?.getLobby();
    if (!lobby || lobby.mode !== "teams") return;
    (lobby as TeamLobbyService).leaveTeam();
  }

  function handleSwitchToFreeForAll() {
    try {
      lobbyRef.current?.switchToFreeForAll();
    } catch (error) {
      addLog(error instanceof Error ? error.message : String(error));
    }
  }

  function handleSwitchToTeams() {
    try {
      lobbyRef.current?.switchToTeams(TEAM_IDS);
    } catch (error) {
      addLog(error instanceof Error ? error.message : String(error));
    }
  }

  function handleBroadcastTest() {
    sessionRef.current?.broadcast({ type: "ping", text: "hello lobby!" });
    addLog("Broadcast test app message");
  }

  useEffect(() => {
    if (!joined) return;
    const interval = setInterval(() => {
      refreshPlayers();
      refreshHostFlag();
    }, 500);
    return () => clearInterval(interval);
  }, [joined]);

  useEffect(() => {
    return () => {
      lobbyRef.current?.dispose();
      void sessionRef.current?.leave();
      sessionRef.current = null;
      lobbyRef.current = null;
    };
  }, []);

  const localPlayer = lobbyRef.current?.getLobby().getLocalPlayer();
  const teamLobby =
    mode === "teams" ? (lobbyRef.current?.getLobby() as TeamLobbyService | undefined) : undefined;
  const playersByTeam = teamLobby?.getPlayersByTeam();
  const unassigned = teamLobby?.getUnassignedPlayers();

  return (
    <div style={{ fontFamily: "monospace", padding: 16, display: "flex", gap: 24 }}>
      <div style={{ minWidth: 320 }}>
        <h3>Lobby Test — room "{ROOM_ID}"</h3>

        {!joined ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="nickname"
            />
            <button onClick={handleJoin}>Join</button>
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <button onClick={handleLeave}>Leave</button>
            <span style={{ marginLeft: 12 }}>
              You are: <b>{isHost ? "HOST" : "guest"}</b> | mode: <b>{mode}</b>
            </span>
          </div>
        )}

        {joined && localPlayer && (
          <div style={{ marginBottom: 16 }}>
            <div>
              Local: <b>{localPlayer.nickname}</b> ({short(localPlayer.peerId)}) — ready=
              {String(localPlayer.ready)} team={localPlayer.teamId ?? "-"}
            </div>
            <button onClick={handleToggleReady}>Toggle ready</button>
            {mode === "teams" && (
              <>
                {TEAM_IDS.map((teamId) => (
                  <button
                    key={teamId}
                    onClick={() => handleChooseTeam(teamId)}
                    style={{ marginLeft: 8 }}
                  >
                    Join {teamId}
                  </button>
                ))}
                <button onClick={handleLeaveTeam} style={{ marginLeft: 8 }}>
                  Leave team
                </button>
              </>
            )}
          </div>
        )}

        {joined && isHost && (
          <div style={{ marginBottom: 16 }}>
            <b>Host controls:</b>
            <div>
              <button onClick={handleSwitchToFreeForAll}>Switch: free-for-all</button>
              <button onClick={handleSwitchToTeams} style={{ marginLeft: 8 }}>
                Switch: teams
              </button>
            </div>
          </div>
        )}

        {joined && (
          <button onClick={handleBroadcastTest} style={{ marginBottom: 16 }}>
            Broadcast test app message
          </button>
        )}

        {joined && (
          <div>
            <b>Players ({players.length}):</b>
            {mode === "free-for-all" && (
              <ul>
                {players.map((p) => (
                  <li key={p.peerId}>
                    {p.nickname} ({short(p.peerId)}) — ready={String(p.ready)}
                  </li>
                ))}
              </ul>
            )}
            {mode === "teams" && playersByTeam && (
              <>
                {TEAM_IDS.map((teamId) => (
                  <div key={teamId}>
                    <u>{teamId}</u>
                    <ul>
                      {playersByTeam[teamId]?.map((p) => (
                        <li key={p.peerId}>
                          {p.nickname} ({short(p.peerId)}) — ready={String(p.ready)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <div>
                  <u>Unassigned</u>
                  <ul>
                    {unassigned?.map((p) => (
                      <li key={p.peerId}>
                        {p.nickname} ({short(p.peerId)}) — ready={String(p.ready)}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          flex: 1,
          maxHeight: 500,
          overflowY: "auto",
          background: "#111",
          color: "#0f0",
          padding: 8,
        }}
      >
        {log.map((entry, i) => (
          <div key={i}>
            [{entry.timestamp}] {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}
