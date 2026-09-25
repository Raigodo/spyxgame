"use client";

import { useEffect, useRef, useState } from "react";
import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import { PlayerSession } from "@/shared/infrastructure/player/player-session";
import { WebRtcService } from "@/shared/infrastructure/webrtc/web-rtc-service";
import type { LocalProfileInput, PlayerProfile } from "../infrastructure/player/types";

const ROOM_ID = "player-session-test";

interface LogEntry {
  timestamp: string;
  text: string;
}

export function PlayerSessionTest() {
  const serviceRef = useRef<PlayerSession | null>(null);

  const [nickname, setNickname] = useState(() => `Player-${Math.floor(Math.random() * 1000)}`);

  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [localPlayer, setLocalPlayer] = useState<PlayerProfile | undefined>();
  const [players, setPlayers] = useState<PlayerProfile[]>([]);
  const [message, setMessage] = useState("hello!");
  const [log, setLog] = useState<LogEntry[]>([]);

  function addLog(text: string) {
    const timestamp = new Date().toLocaleTimeString("en", {
      hour12: false,
    });

    setLog((prev) => [...prev, { timestamp, text }]);
  }

  function refreshState(service: PlayerSession) {
    setPlayers(service.getPlayers());
    setLocalPlayer(service.getLocalPlayer());
    setIsHost(service.isHost());
  }

  async function handleJoin() {
    if (serviceRef.current) return;

    const rtc = new WebRtcService();
    const service = new PlayerSession(rtc);

    serviceRef.current = service;

    service.onPlayerJoined((player) => {
      addLog(`Player joined: ${short(player.peerId)} "${player.nickname}"`);

      refreshState(service);
    });

    service.onPlayerUpdated((player) => {
      addLog(`Player updated: ${short(player.peerId)} "${player.nickname}"`);

      refreshState(service);
    });

    service.onPlayerLeft((player) => {
      addLog(`Player left: ${short(player.peerId)} "${player.nickname}"`);

      refreshState(service);
    });

    service.onMessage((payload, from) => {
      addLog(`Message from ${short(from)}: ${formatPayload(payload)}`);
    });

    const profile: LocalProfileInput = {
      nickname,
      metadata: {
        ready: false,
      },
    };

    try {
      await service.join(ROOM_ID, profile);

      refreshState(service);
      setJoined(true);

      addLog(
        `Joined room="${ROOM_ID}" as "${nickname}" ${service.isHost() ? "(host)" : "(guest)"}`
      );
    } catch (error) {
      serviceRef.current = null;

      const errorMessage = error instanceof Error ? error.message : String(error);

      addLog(`Failed to join: ${errorMessage}`);
    }
  }

  async function handleLeave() {
    const service = serviceRef.current;

    if (!service) return;

    try {
      await service.leave();
    } finally {
      serviceRef.current = null;

      setJoined(false);
      setIsHost(false);
      setLocalPlayer(undefined);
      setPlayers([]);

      addLog("Left room");
    }
  }

  function handleSendDirect(targetPeerId: SignalingPeerId) {
    const service = serviceRef.current;

    if (!service) return;

    service.sendToPlayer(targetPeerId, message);

    addLog(`Sent direct to ${short(targetPeerId)}: "${message}"`);
  }

  function handleBroadcast() {
    const service = serviceRef.current;

    if (!service) return;

    service.broadcast(message);

    addLog(`Broadcast: "${message}"`);
  }

  function handleToggleReady() {
    const service = serviceRef.current;

    if (!service) return;

    const player = service.getLocalPlayer();

    if (!player) return;

    const ready = player.metadata.ready === true;

    service.updateLocalProfile({
      metadata: {
        ready: !ready,
      },
    });

    refreshState(service);

    addLog(`Changed ready=${!ready}`);
  }

  useEffect(() => {
    return () => {
      void serviceRef.current?.leave();
      serviceRef.current = null;
    };
  }, []);

  const localReady = localPlayer?.metadata.ready === true;

  const otherPlayers = players.filter((player) => player.peerId !== localPlayer?.peerId);

  return (
    <div className="space-y-6 mx-auto p-6 max-w-2xl">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-lg">PlayerSession test</h2>

        <span className="font-mono text-gray-400 text-xs">{ROOM_ID}</span>
      </div>

      {/* Join */}
      {!joined ? (
        <div className="space-y-3">
          <div>
            <label className="block mb-1 font-medium text-gray-700 text-sm">Nickname</label>

            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg w-full text-sm"
              placeholder="Your nickname"
            />
          </div>

          <button
            onClick={() => void handleJoin()}
            disabled={!nickname.trim()}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-40 px-4 py-2 rounded-lg text-white text-sm transition-colors disabled:cursor-not-allowed"
          >
            Join room
          </button>
        </div>
      ) : (
        <div className="flex justify-between items-center">
          <div>
            <p className="font-medium text-gray-800 text-sm">{localPlayer?.nickname}</p>

            <p className="text-gray-400 text-xs">
              {localPlayer?.peerId && short(localPlayer.peerId)}

              {isHost ? " · host" : " · guest"}
            </p>
          </div>

          <button
            onClick={() => void handleLeave()}
            className="bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg text-red-600 text-sm transition-colors"
          >
            Leave room
          </button>
        </div>
      )}

      {/* Local player */}
      {joined && localPlayer && (
        <div className="space-y-2">
          <p className="font-medium text-gray-700 text-sm">Local player</p>

          <div className="bg-gray-50 p-4 border border-gray-200 rounded-lg">
            <div className="flex justify-between items-center">
              <div>
                <p className="font-medium text-gray-800 text-sm">{localPlayer.nickname}</p>

                <p className="font-mono text-gray-400 text-xs">{localPlayer.peerId}</p>
              </div>

              <button
                onClick={handleToggleReady}
                className="bg-white hover:bg-gray-100 px-3 py-1.5 border border-gray-200 rounded-lg text-gray-700 text-xs"
              >
                Ready: {localReady ? "yes" : "no"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Players */}
      {joined && (
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <p className="font-medium text-gray-700 text-sm">Players ({players.length})</p>

            {otherPlayers.length > 0 && (
              <button
                onClick={handleBroadcast}
                className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-white text-xs transition-colors"
              >
                Broadcast
              </button>
            )}
          </div>

          {players.length === 0 ? (
            <p className="text-gray-400 text-sm">No players yet.</p>
          ) : (
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
              {players.map((player) => {
                const isLocal = player.peerId === localPlayer?.peerId;

                const ready = player.metadata.ready === true;

                return (
                  <div
                    key={player.peerId}
                    className="flex justify-between items-center bg-white px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-2 h-2 rounded-full ${ready ? "bg-green-500" : "bg-gray-300"}`}
                      />

                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-800 text-sm">{player.nickname}</p>

                          {isLocal && (
                            <span className="bg-gray-100 px-1.5 py-0.5 rounded text-[10px] text-gray-500">
                              YOU
                            </span>
                          )}
                        </div>

                        <p className="font-mono text-gray-400 text-xs">{short(player.peerId)}</p>
                      </div>
                    </div>

                    {!isLocal && (
                      <button
                        onClick={() => handleSendDirect(player.peerId)}
                        disabled={!message}
                        className="bg-gray-100 hover:bg-gray-200 disabled:opacity-40 px-3 py-1.5 rounded-lg text-gray-700 text-xs transition-colors"
                      >
                        Send direct
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Message */}
      {joined && (
        <div className="space-y-3">
          <p className="font-medium text-gray-700 text-sm">Message</p>

          <div className="flex gap-2">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              placeholder="Message"
            />

            <button
              onClick={handleBroadcast}
              disabled={!message}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 px-3 py-2 rounded-lg text-white text-xs"
            >
              Broadcast
            </button>
          </div>
        </div>
      )}

      {/* Log */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <p className="font-medium text-gray-700 text-sm">Log</p>

          <button
            onClick={() => setLog([])}
            className="text-gray-400 hover:text-gray-600 text-xs transition-colors"
          >
            Clear
          </button>
        </div>

        <div className="space-y-1 bg-gray-50 p-3 border border-gray-200 rounded-lg h-72 overflow-y-auto">
          {log.length === 0 && <p className="text-gray-400 text-sm">Nothing yet…</p>}

          {log.map((entry, index) => (
            <div key={index} className="flex gap-2 text-xs">
              <span className="tabular-nums text-gray-400 shrink-0">{entry.timestamp}</span>

              <span className="text-gray-700">{entry.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function short(id: string): string {
  return id.slice(0, 8);
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return `"${payload}"`;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
