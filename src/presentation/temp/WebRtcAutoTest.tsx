"use client";

import { useEffect, useRef, useState } from "react";
import { WebRtcService } from "@infrastructure/webrtc/web-rtc-service";

const ROOM_ID = "test-room2";
const TEST_MESSAGE = "hello!";

interface LogEntry {
  timestamp: string;
  text: string;
}

interface PeerRow {
  signalingPeerId: string;
  status: string;
}

export function WebRtcAutoTest() {
  const serviceRef = useRef<WebRtcService | null>(null);

  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  function addLog(text: string) {
    const timestamp = new Date().toLocaleTimeString("en", {
      hour12: false,
    });

    setLog((prev) => [...prev, { timestamp, text }]);
  }

  function refreshPeers() {
    const service = serviceRef.current;

    if (!service) {
      setPeers([]);
      return;
    }

    setPeers(service.getRtcPeers());
  }

  async function handleJoin() {
    if (serviceRef.current) return;

    const service = new WebRtcService();
    serviceRef.current = service;

    service.onRtcPeerJoined((peer) => {
      addLog(
        `RTC peer joined: ${short(peer.signalingPeerId)} status=${peer.status}`,
      );

      refreshPeers();
    });

    service.onRtcPeerLeft((peer) => {
      addLog(
        `RTC peer left: ${short(peer.signalingPeerId)} status=${peer.status}`,
      );

      refreshPeers();
    });

    service.onRtcMessage((message, from) => {
      addLog(`Message from ${short(from)}: "${message}"`);
    });

    try {
      await service.joinRoom(ROOM_ID);

      setJoined(true);
      refreshPeers();

      addLog(`Joined room="${ROOM_ID}"`);
    } catch (error) {
      serviceRef.current = null;

      const message = error instanceof Error ? error.message : String(error);

      addLog(`Failed to join: ${message}`);
    }
  }

  async function handleLeave() {
    const service = serviceRef.current;

    if (!service) return;

    try {
      await service.leaveRoom();
    } finally {
      serviceRef.current = null;
      setJoined(false);
      setPeers([]);

      addLog("Left room");
    }
  }

  function handleSendDirect(signalingPeerId: string) {
    const service = serviceRef.current;

    if (!service) return;

    service.sendMessageToPeer(signalingPeerId, TEST_MESSAGE);

    addLog(`Sent to ${short(signalingPeerId)}: "${TEST_MESSAGE}"`);
  }

  function handleBroadcast() {
    const service = serviceRef.current;

    if (!service) return;

    service.broadcastMessage(TEST_MESSAGE);

    addLog(`Broadcast: "${TEST_MESSAGE}"`);
  }

  useEffect(() => {
    if (!joined) return;

    /*
     * The current WebRtcService changes peer status internally,
     * but does not expose a status-change callback.
     *
     * Therefore we only poll getRtcPeers() to reflect status changes
     * such as connecting -> active -> reconnecting.
     */
    const interval = setInterval(refreshPeers, 500);

    return () => clearInterval(interval);
  }, [joined]);

  useEffect(() => {
    return () => {
      void serviceRef.current?.leaveRoom();
      serviceRef.current = null;
    };
  }, []);

  const hasActivePeer = peers.some((peer) => peer.status === "active");

  return (
    <div className="space-y-6 mx-auto p-6 max-w-2xl">
      {" "}
      <div className="flex justify-between items-center">
        {" "}
        <h2 className="font-semibold text-lg">WebRTC test</h2>
        <span className="font-mono text-gray-400 text-xs">{ROOM_ID}</span>
      </div>
      {/* Join / leave */}
      {!joined ? (
        <button
          onClick={() => void handleJoin()}
          className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-white text-sm transition-colors"
        >
          Join room
        </button>
      ) : (
        <button
          onClick={() => void handleLeave()}
          className="bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg text-red-600 text-sm transition-colors"
        >
          Leave room
        </button>
      )}
      {/* RTC peers */}
      {joined && (
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <p className="font-medium text-gray-700 text-sm">
              RTC peers ({peers.length})
            </p>

            {hasActivePeer && (
              <button
                onClick={handleBroadcast}
                className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-white text-xs transition-colors"
              >
                Broadcast
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

        <div className="space-y-1 bg-gray-50 p-3 border border-gray-200 rounded-lg h-64 overflow-y-auto">
          {log.length === 0 && (
            <p className="text-gray-400 text-sm">Nothing yet…</p>
          )}

          {log.map((entry, index) => (
            <div key={index} className="flex gap-2 text-xs">
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
    connecting: "bg-yellow-400 animate-pulse",
    active: "bg-green-500",
    reconnecting: "bg-yellow-400 animate-pulse",
    dead: "bg-red-400",
  };

  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${
        colors[status] ?? "bg-gray-300"
      }`}
    />
  );
}

function short(id: string): string {
  return id.slice(0, 8);
}
