"use client";

import { useEffect, useRef, useState } from "react";
import { IncomingSignal, SignalingService } from "@/infrastructure/signaling";

type LogEntry = {
  id: string;
  message: string;
};

export function nextGuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export default function FirestoreSignalingTest() {
  const serviceRef = useRef<SignalingService | null>(null);

  const [roomId, setRoomId] = useState("test-room");
  const [peerId, setPeerId] = useState<string | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [joined, setJoined] = useState(false);

  const [targetPeer, setTargetPeer] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);

  function log(message: string) {
    const entry = {
      id: nextGuid(),
      message,
    };

    console.log(`[Firestore Test] ${message}`);

    setLogs((current) => [entry, ...current]);
  }

  /*
   * Create the service once.
   *
   * We don't create it inside useEffect, because the service itself
   * doesn't depend on React.
   */
  // eslint-disable-next-line react-hooks/refs
  if (!serviceRef.current) {
    serviceRef.current = new SignalingService();
  }

  useEffect(() => {
    const service = serviceRef.current;

    if (!service) {
      console.error("Service was not initialized.");
      return;
    }

    log("Service initialized.");

    const unsubscribeJoined = service.onPeerJoined((newPeerId) => {
      log(`EVENT: peer joined -> ${newPeerId}`);

      setPeers((current) => {
        if (current.includes(newPeerId)) {
          return current;
        }

        return [...current, newPeerId];
      });
    });

    const unsubscribeLeft = service.onPeerLeft((leftPeerId) => {
      log(`EVENT: peer left -> ${leftPeerId}`);

      setPeers((current) => current.filter((id) => id !== leftPeerId));
    });

    const unsubscribeSignal = service.onSignal((signal) => {
      log(`EVENT: signal received -> ${signal.type} from ${signal.from}`);
    });

    return () => {
      unsubscribeJoined();
      unsubscribeLeft();
      unsubscribeSignal();
    };
  }, []);

  async function handleJoin() {
    const service = serviceRef.current;

    if (!service) {
      log("ERROR: service does not exist.");
      return;
    }

    if (!roomId.trim()) {
      log("ERROR: room ID is empty.");
      return;
    }

    log(`Joining room "${roomId}"...`);

    try {
      const result = await service.joinRoom(roomId.trim());

      setPeerId(result.peerId);
      setPeers(result.existingParticipants);
      setJoined(true);

      log(`SUCCESS: joined room "${result.roomId}".`);
      log(`My peer ID: ${result.peerId}`);

      if (result.existingParticipants.length === 0) {
        log("No other participants are currently in the room.");
      } else {
        log(
          `Found ${result.existingParticipants.length} existing participant(s):`,
        );

        for (const peer of result.existingParticipants) {
          log(`  Existing peer: ${peer}`);
        }
      }
    } catch (error) {
      console.error("Join error:", error);

      log(
        `ERROR joining room: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function handleLeave() {
    const service = serviceRef.current;

    if (!service) {
      log("ERROR: service does not exist.");
      return;
    }

    log("Leaving room...");

    try {
      await service.leaveRoom();

      setJoined(false);
      setPeerId(null);
      setPeers([]);

      log("SUCCESS: left room.");
    } catch (error) {
      console.error("Leave error:", error);

      log(
        `ERROR leaving room: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function handleSendSignal(type: IncomingSignal["type"]) {
    const service = serviceRef.current;

    if (!service) {
      log("ERROR: service does not exist.");
      return;
    }

    if (!targetPeer.trim()) {
      log("ERROR: target peer ID is empty.");
      return;
    }

    let payload: IncomingSignal["payload"];

    switch (type) {
      case "offer":
        payload = {
          offer: {
            type: "offer",
            sdp: "TEST-OFFER",
          },
        };
        break;

      case "answer":
        payload = {
          answer: {
            type: "answer",
            sdp: "TEST-ANSWER",
          },
        };
        break;

      case "candidate":
        payload = {
          candidate: {
            candidate: "TEST-CANDIDATE",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        };
        break;
    }

    log(`Sending ${type} to ${targetPeer}...`);

    try {
      await service.sendSignal(targetPeer.trim(), type, payload);

      log(`SUCCESS: ${type} sent to ${targetPeer}.`);
    } catch (error) {
      console.error("Signal error:", error);

      log(
        `ERROR sending signal: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return (
    <main className="space-y-6 mx-auto p-8 max-w-3xl">
      <h1 className="font-bold text-2xl">Firestore Signaling Test</h1>

      {/* ROOM */}
      <section className="space-y-3 p-4 border rounded-lg">
        <h2 className="font-semibold">Room</h2>

        <div className="flex gap-2">
          <input
            className="flex-1 px-3 py-2 border rounded"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={joined}
          />

          {!joined ? (
            <button
              className="bg-black px-4 py-2 rounded text-white"
              onClick={handleJoin}
            >
              Join
            </button>
          ) : (
            <button
              className="bg-red-600 px-4 py-2 rounded text-white"
              onClick={handleLeave}
            >
              Leave
            </button>
          )}
        </div>

        <div>
          Status: <strong>{joined ? "JOINED" : "NOT JOINED"}</strong>
        </div>

        <div>
          My peer ID: <code>{peerId ?? "—"}</code>
        </div>
      </section>

      {/* PARTICIPANTS */}
      <section className="space-y-3 p-4 border rounded-lg">
        <h2 className="font-semibold">Participants ({peers.length})</h2>

        {peers.length === 0 ? (
          <div className="text-gray-500">No other participants.</div>
        ) : (
          <div className="space-y-2">
            {peers.map((peer) => (
              <button
                key={peer}
                className="block bg-gray-100 p-2 rounded w-full font-mono text-black text-sm text-left"
                onClick={() => setTargetPeer(peer)}
              >
                {peer}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* SIGNALING */}
      <section className="space-y-3 p-4 border rounded-lg">
        <h2 className="font-semibold">Send test signal</h2>

        <input
          className="px-3 py-2 border rounded w-full font-mono text-sm"
          placeholder="Target peer ID"
          value={targetPeer}
          onChange={(event) => setTargetPeer(event.target.value)}
        />

        <div className="flex gap-2">
          <button
            className="disabled:opacity-50 px-4 py-2 border rounded"
            disabled={!joined}
            onClick={() => handleSendSignal("offer")}
          >
            Offer
          </button>

          <button
            className="disabled:opacity-50 px-4 py-2 border rounded"
            disabled={!joined}
            onClick={() => handleSendSignal("answer")}
          >
            Answer
          </button>

          <button
            className="disabled:opacity-50 px-4 py-2 border rounded"
            disabled={!joined}
            onClick={() => handleSendSignal("candidate")}
          >
            Candidate
          </button>
        </div>
      </section>

      {/* LOG */}
      <section className="space-y-3 p-4 border rounded-lg">
        <div className="flex justify-between items-center">
          <h2 className="font-semibold">Logs</h2>

          <button
            className="px-3 py-1 border rounded text-sm"
            onClick={() => setLogs([])}
          >
            Clear
          </button>
        </div>

        <div className="bg-gray-100 p-3 rounded max-h-96 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="text-gray-500">No logs yet.</div>
          ) : (
            <div className="space-y-1">
              {logs.map((entry) => (
                <div key={entry.id} className="font-mono text-black text-sm">
                  {entry.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
