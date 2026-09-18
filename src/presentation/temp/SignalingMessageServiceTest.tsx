"use client";

import { useEffect, useState } from "react";

import { firestoreClient } from "@/infrastructure/signaling/firestore-client";
import { FirestoreGateway } from "@/infrastructure/signaling/firestore-gateway";
import { FirestoreSignalingMessageService } from "@/infrastructure/signaling/firestore-signaling-message-service";

import type {
  SignalingPeer,
  SignalingMessage,
} from "@/infrastructure/signaling/types";

const gateway = new FirestoreGateway(firestoreClient);

export function SignalingMessageServiceTest() {
  const [roomId, setRoomId] = useState("test-room");
  const [peerId, setPeerId] = useState("");

  const [signalingPeers, setSignalingPeers] = useState<SignalingPeer[]>([]);

  const [targetPeerId, setTargetPeerId] = useState("");

  const [messagePayload, setMessagePayload] = useState(
    JSON.stringify(
      {
        text: "Hello!",
      },
      null,
      2,
    ),
  );

  const [receivedMessages, setReceivedMessages] = useState<SignalingMessage[]>(
    [],
  );

  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [service, setService] =
    useState<FirestoreSignalingMessageService | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPeerId(crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (!joined || !peerId || !roomId) {
      return;
    }

    const messageService = new FirestoreSignalingMessageService(
      gateway,
      roomId,
      peerId,
    );

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setService(messageService);

    messageService.startHandlingMessagesForSignalingPeer(
      peerId,
      {
        async handle(message) {
          setReceivedMessages((previous) => [...previous, message]);
        },
      },
      (message) => {
        console.log("Message received:", message);
      },
    );

    const unsubscribeSignalingPeers = gateway.subscribeToSignalingPeers(
      roomId,
      (nextSignalingPeers) => {
        setSignalingPeers(nextSignalingPeers);
      },
    );

    return () => {
      messageService.stopHandlingMessages();
      unsubscribeSignalingPeers();
    };
  }, [joined, peerId, roomId]);

  async function joinRoom() {
    setError(null);

    try {
      if (!roomId.trim()) {
        throw new Error("Room ID is required.");
      }

      const exists = await gateway.roomExists(roomId);

      if (!exists) {
        await gateway.createRoom(roomId);
      }

      await gateway.addSignalingPeer(roomId, peerId, {
        joinedAt: new Date(),
      });

      setJoined(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function leaveRoom() {
    setError(null);

    try {
      service?.stopHandlingMessages();

      await gateway.removeSignalingPeer(roomId, peerId);

      setJoined(false);
      setService(null);
      setTargetPeerId("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendMessage() {
    setError(null);

    try {
      if (!service) {
        throw new Error("You are not in a room.");
      }

      if (!targetPeerId) {
        throw new Error("Select a Signaling peer.");
      }

      if (targetPeerId === peerId) {
        throw new Error("You cannot send a message to yourself.");
      }

      let payload: unknown;

      try {
        payload = JSON.parse(messagePayload);
      } catch {
        throw new Error("Message payload must be valid JSON.");
      }

      await service.sendMessage({
        toPeerId: targetPeerId,
        payload,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  const otherSignalingPeers = signalingPeers.filter(
    (peer) => peer.peerId !== peerId,
  );

  return (
    <div className="flex flex-col gap-6 mx-auto p-6 max-w-2xl">
      <h1 className="font-semibold text-2xl">Signaling Message Service Test</h1>

      {error && (
        <div className="p-3 border border-red-500 rounded text-red-500 text-sm">
          {error}
        </div>
      )}

      <section className="p-4 border rounded">
        <h2 className="mb-3 font-semibold">Connection</h2>

        <div className="flex flex-col gap-3">
          <input
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={joined}
            placeholder="Room ID"
            className="px-3 py-2 border rounded"
          />

          <div>
            <div className="text-muted-foreground text-xs">
              Your signaling peer ID
            </div>

            <code className="text-sm break-all">{peerId}</code>
          </div>

          {!joined ? (
            <button
              type="button"
              onClick={() => void joinRoom()}
              className="px-3 py-2 border rounded"
            >
              Join Room
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void leaveRoom()}
              className="px-3 py-2 border rounded"
            >
              Leave Room
            </button>
          )}
        </div>
      </section>

      {joined && (
        <>
          <section className="p-4 border rounded">
            <h2 className="mb-3 font-semibold">Signaling peers</h2>

            {otherSignalingPeers.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No other signaling peers.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {otherSignalingPeers.map((peer) => (
                  <button
                    key={peer.peerId}
                    type="button"
                    onClick={() => setTargetPeerId(peer.peerId)}
                    className={`rounded border p-3 text-left ${
                      targetPeerId === peer.peerId ? "border-primary" : ""
                    }`}
                  >
                    <code className="text-sm break-all">{peer.peerId}</code>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="p-4 border rounded">
            <h2 className="mb-3 font-semibold">Send Message</h2>

            <div className="mb-3 text-sm">
              To:{" "}
              <code className="break-all">
                {targetPeerId || "No signaling peer selected"}
              </code>
            </div>

            <textarea
              value={messagePayload}
              onChange={(event) => setMessagePayload(event.target.value)}
              rows={6}
              className="mb-3 p-3 border rounded w-full font-mono text-sm"
            />

            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={!targetPeerId}
              className="disabled:opacity-50 px-4 py-2 border rounded"
            >
              Send Message
            </button>
          </section>

          <section className="p-4 border rounded">
            <h2 className="mb-3 font-semibold">Received Messages</h2>

            {receivedMessages.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No messages received.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {receivedMessages.map((message) => (
                  <div key={message.id} className="bg-muted p-3 rounded">
                    <div className="mb-2 text-muted-foreground text-xs">
                      From: <code>{message.fromPeerId}</code>
                    </div>

                    <pre className="overflow-x-auto text-sm">
                      {JSON.stringify(message.payload, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
