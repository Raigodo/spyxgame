"use client";

import { useEffect, useRef, useState } from "react";

import { WebRtcService } from "@/infrastructure/webrtc/web-rtc-service";
import type { RtcMessage, RtcPeerInfo } from "@/infrastructure/webrtc/types";

export function WebRtcTest() {
  const serviceRef = useRef<WebRtcService | null>(null);

  const [roomId, setRoomId] = useState("test-room");
  const [isHost, setIsHost] = useState(true);

  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<RtcPeerInfo[]>([]);

  const [message, setMessage] = useState("");
  const [receivedMessages, setReceivedMessages] = useState<string[]>([]);

  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (text: string) => {
    setLogs((current) => [
      ...current,
      `[${new Date().toLocaleTimeString()}] ${text}`,
    ]);
  };

  const refreshPeers = () => {
    const service = serviceRef.current;

    if (!service) {
      return;
    }

    setPeers(service.getRtcPeers());
  };

  useEffect(() => {
    const service = new WebRtcService();

    serviceRef.current = service;

    const unsubscribePeerJoined = service.onRtcPeerJoined((peer) => {
      addLog(`RTC peer joined: ${peer.signalingPeerId}`);
      refreshPeers();
    });

    const unsubscribePeerLeft = service.onRtcPeerLeft((peer) => {
      addLog(`RTC peer left: ${peer.signalingPeerId}`);
      refreshPeers();
    });

    const unsubscribeMessage = service.onRtcMessage(
      (message: RtcMessage, from) => {
        addLog(`Message received from ${from.signalingPeerId}`);

        setReceivedMessages((current) => [
          ...current,
          `${from.signalingPeerId}: ${JSON.stringify(message)}`,
        ]);
      },
    );

    return () => {
      unsubscribePeerJoined();
      unsubscribePeerLeft();
      unsubscribeMessage();

      void service.leaveRoom();
      serviceRef.current = null;
    };
  }, []);

  const handleJoin = async () => {
    const service = serviceRef.current;

    if (!service || joined) {
      return;
    }

    try {
      addLog(`Joining room "${roomId}" as ${isHost ? "host" : "guest"}...`);

      await service.joinRoom(roomId, isHost);

      setJoined(true);
      refreshPeers();

      addLog("Joined room.");
    } catch (error) {
      console.error(error);

      addLog(
        `Join failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const handleLeave = async () => {
    const service = serviceRef.current;

    if (!service) {
      return;
    }

    try {
      await service.leaveRoom();

      setJoined(false);
      setPeers([]);

      addLog("Left room.");
    } catch (error) {
      console.error(error);

      addLog(
        `Leave failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const handleSendToPeer = (peer: RtcPeerInfo) => {
    const service = serviceRef.current;

    if (!service || !message.trim()) {
      return;
    }

    try {
      const rtcMessage: RtcMessage = {
        type: "chat",
        content: message,
      };

      service.sendRtcMessage(peer.signalingPeerId, rtcMessage);

      addLog(`Sent message to ${peer.signalingPeerId}`);

      setMessage("");
    } catch (error) {
      console.error(error);

      addLog(
        `Send failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const handleBroadcast = () => {
    const service = serviceRef.current;

    if (!service || !message.trim()) {
      return;
    }

    try {
      const rtcMessage: RtcMessage = {
        type: "chat",
        content: message,
      };

      service.broadcastRtcMessage(rtcMessage);

      addLog("Broadcast message sent.");

      setMessage("");
    } catch (error) {
      console.error(error);

      addLog(
        `Broadcast failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  return (
    <div className="flex flex-col gap-6 mx-auto p-6 max-w-4xl">
      <h1 className="font-bold text-2xl">WebRTC Service Test</h1>

      {/* Room controls */}
      <section className="p-4 border rounded-lg">
        <h2 className="mb-4 font-semibold text-lg">Room</h2>

        <div className="flex flex-wrap gap-3">
          <input
            className="px-3 py-2 border rounded"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={joined}
            placeholder="Room ID"
          />

          <select
            className="px-3 py-2 border rounded"
            value={isHost ? "host" : "guest"}
            onChange={(event) => setIsHost(event.target.value === "host")}
            disabled={joined}
          >
            <option value="host">Host</option>
            <option value="guest">Guest</option>
          </select>

          {!joined ? (
            <button
              className="bg-black px-4 py-2 rounded text-white"
              onClick={() => void handleJoin()}
            >
              Join room
            </button>
          ) : (
            <button
              className="bg-red-600 px-4 py-2 rounded text-white"
              onClick={() => void handleLeave()}
            >
              Leave room
            </button>
          )}
        </div>

        <div className="mt-3">
          Status: <strong>{joined ? "Joined" : "Not joined"}</strong>
        </div>
      </section>

      {/* Peers */}
      <section className="p-4 border rounded-lg">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-lg">RTC Peers ({peers.length})</h2>

          <button className="px-3 py-1 border rounded" onClick={refreshPeers}>
            Refresh
          </button>
        </div>

        {peers.length === 0 ? (
          <p className="text-gray-500">No RTC peers.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {peers.map((peer) => (
              <div key={peer.signalingPeerId} className="p-3 border rounded">
                <div>
                  <strong>{peer.signalingPeerId}</strong>
                </div>

                <div className="text-sm">RTC ID: {peer.rtcPeerId}</div>

                <div className="text-sm">
                  Status: <strong>{peer.status}</strong>
                </div>

                <button
                  className="bg-blue-600 mt-2 px-3 py-1 rounded text-white"
                  disabled={peer.status !== "active" || !message.trim()}
                  onClick={() => handleSendToPeer(peer)}
                >
                  Send to this peer
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Messages */}
      <section className="p-4 border rounded-lg">
        <h2 className="mb-4 font-semibold text-lg">Messages</h2>

        <div className="flex gap-2">
          <input
            className="flex-1 px-3 py-2 border rounded"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Message..."
            disabled={!joined}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleBroadcast();
              }
            }}
          />

          <button
            className="bg-green-600 px-4 py-2 rounded text-white"
            disabled={!joined || !message.trim()}
            onClick={handleBroadcast}
          >
            Broadcast
          </button>
        </div>

        <div className="flex flex-col gap-2 mt-4">
          {receivedMessages.length === 0 ? (
            <p className="text-gray-500">No messages received.</p>
          ) : (
            receivedMessages.map((item, index) => (
              <div key={index} className="bg-gray-100 p-2 rounded text-black">
                {item}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Logs */}
      <section className="p-4 border rounded-lg">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-lg">Logs</h2>

          <button
            className="px-3 py-1 border rounded"
            onClick={() => setLogs([])}
          >
            Clear
          </button>
        </div>

        <pre className="bg-gray-100 p-3 rounded max-h-80 overflow-auto text-black text-sm">
          {logs.join("\n")}
        </pre>
      </section>
    </div>
  );
}
