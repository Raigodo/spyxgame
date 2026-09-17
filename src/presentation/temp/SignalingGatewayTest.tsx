"use client";

import { useEffect, useState } from "react";

import { firestoreClient } from "@/infrastructure/signaling/firestore-client";
import { FirestoreGateway } from "@/infrastructure/signaling/firestore-gateway";

import type {
  Participant,
  SignalingMessage,
} from "@/infrastructure/signaling/types";

const gateway = new FirestoreGateway(firestoreClient);

export function SignalingGatewayTest() {
  const [roomId, setRoomId] = useState("test-room");
  const [peerId, setPeerId] = useState("");

  const [roomExists, setRoomExists] = useState<boolean | null>(null);

  const [participants, setParticipants] = useState<Participant[]>([]);

  const [messages, setMessages] = useState<SignalingMessage[]>([]);

  const [messageTarget, setMessageTarget] = useState("");
  const [messagePayload, setMessagePayload] = useState(
    JSON.stringify(
      {
        type: "test",
        text: "Hello",
      },
      null,
      2,
    ),
  );

  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const log = (message: string) => {
    setLogs((previous) => [
      `${new Date().toLocaleTimeString()} ${message}`,
      ...previous,
    ]);
  };

  const run = async (operation: () => Promise<void>) => {
    setError(null);

    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      setError(message);
      log(`[ERROR] ${message}`);
    }
  };

  /*
   * Generate a peer ID once when the component mounts.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPeerId(crypto.randomUUID());
  }, []);

  /*
   * Subscribe to participants.
   *
   * This subscription is intentionally always active once
   * a room ID exists, so you can open this page in two tabs
   * and observe changes made by the other tab.
   */
  useEffect(() => {
    if (!roomId.trim()) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    log(`[SUBSCRIBE] Participants: ${roomId}`);

    const unsubscribe = gateway.subscribeToParticipants(
      roomId,
      (nextParticipants) => {
        setParticipants(nextParticipants);

        log(`[PARTICIPANTS] ${nextParticipants.length} participant(s)`);
      },
    );

    return () => {
      unsubscribe();

      log(`[UNSUBSCRIBE] Participants: ${roomId}`);
    };
  }, [roomId]);

  /*
   * Subscribe to messages addressed to this peer.
   */
  useEffect(() => {
    if (!roomId.trim() || !peerId) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    log(`[SUBSCRIBE] Messages for ${peerId}`);

    const unsubscribe = gateway.subscribeToMessages(
      roomId,
      peerId,
      (message) => {
        setMessages((previous) => [...previous, message]);

        log(`[MESSAGE] From ${message.fromPeerId}`);
      },
    );

    return () => {
      unsubscribe();

      log(`[UNSUBSCRIBE] Messages for ${peerId}`);
    };
  }, [roomId, peerId]);

  async function handleCreateRoom() {
    await run(async () => {
      await gateway.createRoom(roomId);

      log(`[ROOM CREATED] ${roomId}`);
    });
  }

  async function handleCheckRoom() {
    await run(async () => {
      const exists = await gateway.roomExists(roomId);

      setRoomExists(exists);

      log(`[ROOM EXISTS] ${roomId}: ${exists}`);
    });
  }

  async function handleAddParticipant() {
    await run(async () => {
      await gateway.addParticipant(roomId, peerId, {
        joinedAt: new Date(),
      });

      log(`[PARTICIPANT ADDED] ${peerId}`);
    });
  }

  async function handleRemoveParticipant() {
    await run(async () => {
      await gateway.removeParticipant(roomId, peerId);

      log(`[PARTICIPANT REMOVED] ${peerId}`);
    });
  }

  async function handleGetParticipants() {
    await run(async () => {
      const result = await gateway.getParticipants(roomId);

      setParticipants(result);

      log(`[GET PARTICIPANTS] ${result.length} participant(s)`);
    });
  }

  async function handleCheckParticipant() {
    await run(async () => {
      const exists = await gateway.participantExists(roomId, peerId);

      log(`[PARTICIPANT EXISTS] ${peerId}: ${exists}`);
    });
  }

  async function handleSendMessage() {
    await run(async () => {
      let payload: unknown;

      try {
        payload = JSON.parse(messagePayload);
      } catch {
        throw new Error("Message payload is not valid JSON.");
      }

      const message: SignalingMessage = {
        id: crypto.randomUUID(),
        fromPeerId: peerId,
        toPeerId: messageTarget,
        timestamp: new Date(),
        payload,
      };

      await gateway.addMessage(roomId, message);

      log(`[MESSAGE SENT] ${message.id} → ${messageTarget}`);
    });
  }

  async function handleDeleteMessage(message: SignalingMessage) {
    await run(async () => {
      await gateway.deleteMessage(roomId, peerId, message.id);

      setMessages((previous) =>
        previous.filter((item) => item.id !== message.id),
      );

      log(`[MESSAGE DELETED] ${message.id}`);
    });
  }

  return (
    <div className="flex flex-col gap-6 mx-auto p-6 max-w-5xl">
      <div>
        <h1 className="font-semibold text-2xl">Firestore Gateway Test</h1>

        <p className="text-muted-foreground text-sm">
          Open this page in two browser tabs to test realtime behavior.
        </p>
      </div>

      {error && (
        <div className="p-3 border border-red-500 rounded-md text-red-500 text-sm">
          {error}
        </div>
      )}

      {/* Identity */}
      <section className="p-4 border rounded-lg">
        <h2 className="mb-3 font-semibold">Current Peer</h2>

        <code className="text-sm break-all">{peerId || "Generating..."}</code>
      </section>

      {/* Room */}
      <section className="p-4 border rounded-lg">
        <h2 className="mb-3 font-semibold">Room</h2>

        <div className="flex flex-wrap gap-2">
          <input
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            className="flex-1 px-3 py-2 border rounded-md min-w-[200px]"
            placeholder="Room ID"
          />

          <button
            type="button"
            onClick={() => void handleCreateRoom()}
            className="px-3 py-2 border rounded-md"
          >
            Create Room
          </button>

          <button
            type="button"
            onClick={() => void handleCheckRoom()}
            className="px-3 py-2 border rounded-md"
          >
            Check Room
          </button>
        </div>

        {roomExists !== null && (
          <p className="mt-3 text-sm">
            Exists: <strong>{roomExists ? "yes" : "no"}</strong>
          </p>
        )}
      </section>

      {/* Participants */}
      <section className="p-4 border rounded-lg">
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Participants</h2>

          <span className="text-muted-foreground text-sm">
            {participants.length}
          </span>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <button
            type="button"
            onClick={() => void handleAddParticipant()}
            className="px-3 py-2 border rounded-md"
          >
            Add Me
          </button>

          <button
            type="button"
            onClick={() => void handleRemoveParticipant()}
            className="px-3 py-2 border rounded-md"
          >
            Remove Me
          </button>

          <button
            type="button"
            onClick={() => void handleGetParticipants()}
            className="px-3 py-2 border rounded-md"
          >
            Get Participants
          </button>

          <button
            type="button"
            onClick={() => void handleCheckParticipant()}
            className="px-3 py-2 border rounded-md"
          >
            Check Me
          </button>
        </div>

        {participants.length === 0 ? (
          <p className="text-muted-foreground text-sm">No participants.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {participants.map((participant) => (
              <div key={participant.peerId} className="bg-muted p-3 rounded-md">
                <code className="text-sm break-all">{participant.peerId}</code>

                <div className="mt-1 text-muted-foreground text-xs">
                  Joined: {participant.joinedAt.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Messages */}
      <section className="p-4 border rounded-lg">
        <h2 className="mb-3 font-semibold">Send Message</h2>

        <div className="flex flex-col gap-3">
          <input
            value={messageTarget}
            onChange={(event) => setMessageTarget(event.target.value)}
            placeholder="Target peer ID"
            className="px-3 py-2 border rounded-md font-mono text-sm"
          />

          <textarea
            value={messagePayload}
            onChange={(event) => setMessagePayload(event.target.value)}
            rows={7}
            className="px-3 py-2 border rounded-md font-mono text-sm"
          />

          <button
            type="button"
            onClick={() => void handleSendMessage()}
            disabled={!messageTarget.trim()}
            className="self-start disabled:opacity-50 px-4 py-2 border rounded-md"
          >
            Send Message
          </button>
        </div>
      </section>

      {/* Received messages */}
      <section className="p-4 border rounded-lg">
        <h2 className="mb-3 font-semibold">Received Messages</h2>

        {messages.length === 0 ? (
          <p className="text-muted-foreground text-sm">No messages received.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <div key={message.id} className="bg-muted p-3 rounded-md">
                <div className="flex flex-wrap justify-between gap-2 mb-2 text-muted-foreground text-xs">
                  <span>
                    From: <code>{message.fromPeerId}</code>
                  </span>

                  <span>{message.timestamp.toLocaleString()}</span>
                </div>

                <pre className="overflow-x-auto text-sm">
                  {JSON.stringify(message.payload, null, 2)}
                </pre>

                <button
                  type="button"
                  onClick={() => void handleDeleteMessage(message)}
                  className="mt-3 px-3 py-1 border rounded-md text-xs"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Logs */}
      <section className="p-4 border rounded-lg">
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Event Log</h2>

          <button
            type="button"
            onClick={() => setLogs([])}
            className="px-3 py-1 border rounded-md text-xs"
          >
            Clear
          </button>
        </div>

        <div className="bg-muted p-3 rounded-md max-h-80 overflow-y-auto">
          {logs.length === 0 ? (
            <span className="text-muted-foreground text-sm">No events.</span>
          ) : (
            <div className="flex flex-col gap-1">
              {logs.map((entry, index) => (
                <div key={`${entry}-${index}`} className="font-mono text-xs">
                  {entry}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
