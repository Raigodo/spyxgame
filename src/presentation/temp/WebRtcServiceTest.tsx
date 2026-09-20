"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { WebRtcService } from "@infrastructure/webrtc/web-rtc-service";

const ROOM_ID = "test-room";
const TEST_MESSAGE = "hello!";

interface LogEntry {
  timestamp: string;
  text: string;
}

interface PeerRow {
  signalingPeerId: string;
  status: string;
}

export function WebRtcServiceTest() {
  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  const serviceRef = useRef<WebRtcService | null>(null);

  function addLog(text: string) {
    const timestamp = new Date().toLocaleTimeString("en", { hour12: false });
    setLog((prev) => [...prev, { timestamp, text }]);
  }

  const refreshPeers = useCallback(() => {
    setPeers(serviceRef.current?.getRtcPeers() ?? []);
  }, []);

  async function handleJoin() {
    const service = new WebRtcService();
    serviceRef.current = service;

    service.onRtcPeerJoined((peer) => {
      addLog(
        `Peer joined: ${short(peer.signalingPeerId)} status=${peer.status}`,
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

    await service.joinRoom(ROOM_ID);
    setJoined(true);
    addLog(`Joined room="${ROOM_ID}"`);
  }

  async function handleLeave() {
    await serviceRef.current?.leaveRoom();
    serviceRef.current = null;
    setJoined(false);
    setPeers([]);
    addLog("Left room");
  }

  async function handleBecomeHost() {
    await serviceRef.current?.setRole(true);
    addLog("Role set → host");
    refreshPeers();
  }

  async function handleBecomeGuest() {
    await serviceRef.current?.setRole(false);
    addLog("Role set → guest");
    refreshPeers();
  }

  function handleSendDirect(signalingPeerId: string) {
    serviceRef.current?.sendMessageToPeer(signalingPeerId, TEST_MESSAGE);
    addLog(`Sent to ${short(signalingPeerId)}: "${TEST_MESSAGE}"`);
  }

  function handleBroadcast() {
    serviceRef.current?.broadcastMessage(TEST_MESSAGE);
    addLog(`Broadcast: "${TEST_MESSAGE}"`);
  }

  // Refresh peer statuses every second to catch connecting → active.
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
        <button
          onClick={handleJoin}
          className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-white text-sm transition-colors"
        >
          Join room
        </button>
      ) : (
        <div className="flex items-center gap-3">
          <button
            onClick={handleBecomeHost}
            className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-white text-sm transition-colors"
          >
            Become host
          </button>
          <button
            onClick={handleBecomeGuest}
            className="bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg text-gray-800 text-sm transition-colors"
          >
            Become guest
          </button>
          <button
            onClick={handleLeave}
            className="bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg text-red-600 text-sm transition-colors"
          >
            Leave room
          </button>
        </div>
      )}

      {/* ─── Peers ─── */}
      {joined && (
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <p className="font-medium text-gray-700 text-sm">
              RTC peers ({peers.length})
            </p>
            {peers.some((p) => p.status === "active") && (
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
              No peers yet — open another tab and become host.
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
          <p className="font-medium text-gray-700 text-sm">Log</p>
          <button
            onClick={() => setLog([])}
            className="text-gray-400 hover:text-gray-600 text-xs transition-colors"
          >
            Clear
          </button>
        </div>
        <div className="space-y-1 bg-gray-50 p-3 border border-gray-200 rounded-lg h-64 overflow-y-auto">
          {log.length === 0 && (
            <p className="text-gray-400 text-sm">Nothing yet…</p>
          )}
          {log.map((entry, i) => (
            <div key={i} className="flex gap-2 text-xs">
              <span className="tabular-nums text-gray-400 shrink-0">
                {entry.timestamp}
              </span>
              <span className="text-gray-700">{entry.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    connecting: "bg-yellow-400",
    active: "bg-green-500",
    reconnecting: "bg-yellow-400 animate-pulse",
    dead: "bg-red-400",
  };

  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${colors[status] ?? "bg-gray-300"}`}
    />
  );
}

function short(id: string): string {
  return id.slice(0, 8);
}
