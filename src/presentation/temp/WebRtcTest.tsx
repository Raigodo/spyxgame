"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { WebRtcService } from "@infrastructure/webrtc/attempt-2/web-rtc-service";
import type { RtcPeerStatus } from "@infrastructure/webrtc/types";
import type { SignalingPeerId } from "@infrastructure/signaling/types";

const ROOM_ID = "test-room";
const TEST_MESSAGE = "hello from peer!";

interface PeerRow {
  signalingPeerId: SignalingPeerId;
  status: RtcPeerStatus;
}

interface LogEntry {
  timestamp: string;
  text: string;
}

export function WebRtcTest() {
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  const serviceRef = useRef<WebRtcService | null>(null);

  function addLog(text: string) {
    const timestamp = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, { timestamp, text }]);
  }

  const refreshPeers = useCallback(() => {
    const service = serviceRef.current;
    if (!service) return;
    setPeers(service.getRtcPeers());
  }, []);

  async function handleJoin() {
    const service = new WebRtcService();
    serviceRef.current = service;

    service.onRtcPeerJoined((peer) => {
      addLog(
        `Peer joined: ${short(peer.signalingPeerId)} — status=${peer.status}`,
      );
      refreshPeers();
    });

    service.onRtcPeerLeft((peer) => {
      addLog(`Peer left: ${short(peer.signalingPeerId)}`);
      refreshPeers();
    });

    service.onRtcMessage((message, from) => {
      addLog(`Message from ${short(from)}: "${message}"`);
    });

    await service.joinRoom(ROOM_ID, isHost);
    setJoined(true);
    addLog(`Joined room="${ROOM_ID}" as ${isHost ? "host" : "guest"}`);
  }

  async function handleLeave() {
    await serviceRef.current?.leaveRoom();
    serviceRef.current = null;
    setJoined(false);
    setPeers([]);
    addLog("Left room");
  }

  function handleSendDirect(signalingPeerId: SignalingPeerId) {
    serviceRef.current?.sendMessageToPeer(signalingPeerId, TEST_MESSAGE);
    addLog(`Sent direct to ${short(signalingPeerId)}: "${TEST_MESSAGE}"`);
  }

  function handleBroadcast() {
    serviceRef.current?.broadcastMessage(TEST_MESSAGE);
    addLog(`Broadcast: "${TEST_MESSAGE}"`);
  }

  // Periodically refresh peer statuses to catch connecting → active transitions.
  useEffect(() => {
    if (!joined) return;
    const interval = setInterval(refreshPeers, 1000);
    return () => clearInterval(interval);
  }, [joined, refreshPeers]);

  return (
    <div className="space-y-6 mx-auto p-6 max-w-2xl">
      <h2 className="font-semibold text-lg">WebRTC service test</h2>
      <p className="text-gray-500 text-sm">
        Room: <code className="bg-gray-100 px-1 rounded">{ROOM_ID}</code>
      </p>

      {/* ─── Join / leave ─── */}
      {!joined ? (
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-gray-700 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isHost}
              onChange={(e) => setIsHost(e.target.checked)}
              className="w-4 h-4"
            />
            Join as host
          </label>
          <button
            onClick={handleJoin}
            className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-white text-sm transition-colors"
          >
            Join room
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <span className="text-gray-500 text-sm">
            Joined as{" "}
            <span className="font-medium text-gray-800">
              {isHost ? "host" : "guest"}
            </span>
          </span>
          <button
            onClick={handleLeave}
            className="bg-red-50 hover:bg-red-100 px-4 py-2 rounded-lg text-red-600 text-sm transition-colors"
          >
            Leave room
          </button>
        </div>
      )}

      {/* ─── Peers ─── */}
      {joined && (
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <h3 className="font-medium text-gray-700 text-sm">
              Active peers ({peers.length})
            </h3>
            {peers.length > 0 && (
              <button
                onClick={handleBroadcast}
                className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-white text-xs transition-colors"
              >
                Broadcast to all
              </button>
            )}
          </div>

          {peers.length === 0 ? (
            <p className="text-gray-400 text-sm">
              No peers yet — open another tab and join.
            </p>
          ) : (
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
              {peers.map((peer) => (
                <div
                  key={peer.signalingPeerId}
                  className="flex justify-between items-center bg-white px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <StatusDot status={peer.status} />
                    <div>
                      <p className="font-mono text-gray-800 text-sm">
                        {short(peer.signalingPeerId)}
                      </p>
                      <p className="text-gray-400 text-xs">{peer.status}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleSendDirect(peer.signalingPeerId)}
                    disabled={peer.status !== "active"}
                    className="bg-gray-100 hover:bg-gray-200 disabled:opacity-40 px-3 py-1.5 rounded-lg text-gray-700 text-xs transition-colors disabled:cursor-not-allowed"
                  >
                    Send direct
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Log ─── */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <h3 className="font-medium text-gray-700 text-sm">Log</h3>
          <button
            onClick={() => setLog([])}
            className="text-gray-400 hover:text-gray-600 text-xs transition-colors"
          >
            Clear
          </button>
        </div>
        <div className="space-y-1 bg-gray-50 p-3 border border-gray-200 rounded-lg h-56 overflow-y-auto">
          {log.length === 0 && (
            <p className="text-gray-400 text-sm">Nothing yet…</p>
          )}
          {log.map((entry, i) => (
            <div key={i} className="flex gap-2 text-xs">
              <span className="text-gray-400 shrink-0">{entry.timestamp}</span>
              <span className="text-gray-700">{entry.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function short(id: string): string {
  return id.slice(0, 8);
}

function StatusDot({ status }: { status: RtcPeerStatus }) {
  const colors: Record<RtcPeerStatus, string> = {
    connecting: "bg-yellow-400",
    active: "bg-green-500",
    reconnecting: "bg-yellow-400 animate-pulse",
    dead: "bg-red-400",
  };

  return <span className={`w-2 h-2 rounded-full shrink-0 ${colors[status]}`} />;
}
