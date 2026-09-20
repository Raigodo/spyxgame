"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { FirestoreSignalingServiceRoot } from "@infrastructure/signaling/firestore-signaling-service-root";
import type { SignalingPeer } from "@infrastructure/signaling/types";
import type { HostDocument } from "@infrastructure/signaling/firestore-host-service";

const ROOM_ID = "test-room";

interface LogEntry {
  timestamp: string;
  text: string;
}

export function HostElectionTest() {
  const [joined, setJoined] = useState(false);
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [peers, setPeers] = useState<SignalingPeer[]>([]);
  const [host, setHost] = useState<HostDocument | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const serviceRef = useRef<FirestoreSignalingServiceRoot | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);

  function addLog(text: string) {
    const timestamp = new Date().toLocaleTimeString("en", { hour12: false });
    setLog((prev) => [...prev, { timestamp, text }]);
  }

  const refreshPeers = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;
    setPeers(service.getSignalingPeers());
  }, []);

  async function handleJoin() {
    const service = new FirestoreSignalingServiceRoot();
    serviceRef.current = service;

    const peerId = await service.joinRoom(ROOM_ID);
    setLocalPeerId(peerId);
    setJoined(true);
    addLog(`Joined room as ${short(peerId)}`);

    // Subscribe to signaling peers.
    cleanupRef.current.push(
      service.onSignalingPeerJoined((peer) => {
        addLog(
          `Signaling peer joined: ${short(peer.peerId)} joinedAt=${peer.joinedAt.toLocaleTimeString()}`,
        );
        void refreshPeers();
      }),
      service.onSignalingPeerLeft((peer) => {
        addLog(`Signaling peer left: ${short(peer.peerId)}`);
        void refreshPeers();
      }),
    );

    // Subscribe to host changes.
    cleanupRef.current.push(
      service.host.onHostChanged((newHost) => {
        setHost(newHost);
        if (newHost) {
          const isSelf = newHost.signalingPeerId === peerId;
          addLog(
            `Host changed → ${short(newHost.signalingPeerId)}${isSelf ? " (me)" : ""} at ${newHost.nominatedAt.toLocaleTimeString()}`,
          );
        } else {
          addLog("Host document cleared");
        }
      }),
    );

    // Initial peer list.
    void refreshPeers();
  }

  async function handleLeave() {
    for (const cleanup of cleanupRef.current) cleanup();
    cleanupRef.current = [];

    await serviceRef.current?.leaveRoom();
    serviceRef.current = null;

    setJoined(false);
    setLocalPeerId(null);
    setPeers([]);
    setHost(null);
    addLog("Left room");
  }

  async function handleElectNext() {
    const service = serviceRef.current;
    if (!service) return;

    addLog("Triggering electNextHost()…");
    const nextPeerId = await service.host.electNextHost();

    if (nextPeerId) {
      addLog(`Elected next host: ${short(nextPeerId)}`);
    } else {
      addLog("No next host candidate found");
    }
  }

  async function handleClearHost() {
    const service = serviceRef.current;
    if (!service) return;
    await service.host.clearHost();
    addLog("Cleared host document manually");
  }

  async function handlePutSelfAsHost() {
    const service = serviceRef.current;
    if (!service || !localPeerId) return;
    await service.host.putNewHost(localPeerId);
    addLog(`Manually set self (${short(localPeerId)}) as host`);
  }

  return (
    <div className="space-y-6 mx-auto p-6 max-w-2xl">
      <h2 className="font-semibold text-lg">Host election test</h2>
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
          <span className="text-gray-500 text-sm">
            Local peer:{" "}
            <code className="bg-gray-100 px-1 rounded text-gray-800">
              {localPeerId ? short(localPeerId) : "—"}
            </code>
          </span>
          <button
            onClick={handleLeave}
            className="bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg text-red-600 text-sm transition-colors"
          >
            Leave room
          </button>
        </div>
      )}

      {/* ─── Actions ─── */}
      {joined && (
        <div className="space-y-2">
          <p className="font-medium text-gray-700 text-sm">Actions</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleElectNext}
              className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-white text-sm transition-colors"
            >
              Elect next host
            </button>
            <button
              onClick={handlePutSelfAsHost}
              className="bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg text-gray-800 text-sm transition-colors"
            >
              Set self as host
            </button>
            <button
              onClick={handleClearHost}
              className="bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg text-red-600 text-sm transition-colors"
            >
              Clear host
            </button>
          </div>
        </div>
      )}

      {/* ─── Host document ─── */}
      {joined && (
        <div className="space-y-2">
          <p className="font-medium text-gray-700 text-sm">Current host</p>
          {host ? (
            <div className="space-y-1 bg-white px-4 py-3 border border-gray-200 rounded-lg">
              <div className="flex items-center gap-2">
                <span className="bg-green-500 rounded-full w-2 h-2 shrink-0" />
                <code className="text-gray-800 text-sm">
                  {short(host.signalingPeerId)}
                  {host.signalingPeerId === localPeerId && (
                    <span className="ml-2 font-medium text-green-600 text-xs">
                      (me)
                    </span>
                  )}
                </code>
              </div>
              <p className="ml-4 text-gray-400 text-xs">
                Nominated at {host.nominatedAt.toLocaleTimeString()}
              </p>
            </div>
          ) : (
            <p className="text-gray-400 text-sm">No host document</p>
          )}
        </div>
      )}

      {/* ─── Signaling peers ─── */}
      {joined && (
        <div className="space-y-2">
          <p className="font-medium text-gray-700 text-sm">
            Signaling peers ({peers.length})
          </p>
          {peers.length === 0 ? (
            <p className="text-gray-400 text-sm">No other peers in room</p>
          ) : (
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
              {[...peers]
                .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
                .map((peer) => (
                  <div
                    key={peer.peerId}
                    className="flex justify-between items-center bg-white px-4 py-2.5"
                  >
                    <div className="flex items-center gap-2">
                      {host?.signalingPeerId === peer.peerId && (
                        <span className="bg-green-500 rounded-full w-2 h-2 shrink-0" />
                      )}
                      {host?.signalingPeerId !== peer.peerId && (
                        <span className="bg-gray-300 rounded-full w-2 h-2 shrink-0" />
                      )}
                      <code className="text-gray-800 text-sm">
                        {short(peer.peerId)}
                      </code>
                    </div>
                    <span className="text-gray-400 text-xs">
                      joined {peer.joinedAt.toLocaleTimeString()}
                    </span>
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
        <div className="space-y-1 bg-gray-50 p-3 border border-gray-200 rounded-lg h-56 overflow-y-auto">
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

function short(id: string): string {
  return id.slice(0, 8);
}
