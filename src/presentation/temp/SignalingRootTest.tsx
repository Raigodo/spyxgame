"use client";

import { useEffect, useState } from "react";

import { SignalingServiceRoot } from "@/infrastructure/signaling";

import type {
  Participant,
  PeerId,
  SignalingMessage,
} from "@/infrastructure/signaling/types";

export function SignalingServiceRootTest() {
  const [roomId, setRoomId] = useState("test-room");

  const [peerId, setPeerId] = useState<PeerId>("");

  const [joined, setJoined] = useState(false);

  const [participants, setParticipants] = useState<Participant[]>([]);

  const [selectedPeerId, setSelectedPeerId] = useState("");

  const [signals, setSignals] = useState<SignalingMessage[]>([]);

  const [sdp, setSdp] = useState("test-sdp");

  const [candidate, setCandidate] = useState("test-candidate");

  const [error, setError] = useState<string | null>(null);

  const [events, setEvents] = useState<string[]>([]);

  const [service] = useState(() => new SignalingServiceRoot());

  function log(message: string) {
    setEvents((previous) => [
      `${new Date().toLocaleTimeString()} ${message}`,
      ...previous,
    ]);
  }

  useEffect(() => {
    const removeJoinedListener = service.onParticipantJoined((participant) => {
      log(`Participant joined: ${participant.peerId}`);

      setParticipants(service.getParticipants());
    });

    const removeLeftListener = service.onParticipantLeft((participant) => {
      log(`Participant left: ${participant.peerId}`);

      setParticipants(service.getParticipants());

      setSelectedPeerId((current) =>
        current === participant.peerId ? "" : current,
      );
    });

    const removeSignalListener = service.onSignalReceived((message) => {
      log(
        `Signal received from ${message.fromPeerId}: ${message.payload.type}`,
      );

      setSignals((previous) => [...previous, message]);
    });

    return () => {
      removeJoinedListener();
      removeLeftListener();
      removeSignalListener();

      void service.leaveRoom();
    };
  }, [service]);

  async function handleJoinRoom() {
    setError(null);

    try {
      const id = await service.joinRoom(roomId);

      setPeerId(id);
      setJoined(true);
      setParticipants(service.getParticipants());

      log(`Joined room: ${roomId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleLeaveRoom() {
    setError(null);

    try {
      await service.leaveRoom();

      setJoined(false);
      setParticipants([]);
      setSelectedPeerId("");

      log("Left room");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSendOffer() {
    if (!selectedPeerId) {
      return;
    }

    setError(null);

    try {
      await service.sendOfferToPeer(selectedPeerId, sdp);

      log(`Offer sent to ${selectedPeerId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSendAnswer() {
    if (!selectedPeerId) {
      return;
    }

    setError(null);

    try {
      await service.sendAnswerToPeer(selectedPeerId, sdp, "remove");

      log(`Answer sent to ${selectedPeerId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSendIceCandidate() {
    if (!selectedPeerId) {
      return;
    }

    setError(null);

    try {
      await service.sendIceCandidateToPeer(selectedPeerId, {
        candidate,
        sdpMid: "0",
        sdpMLineIndex: 0,
      });

      log(`ICE candidate sent to ${selectedPeerId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="flex flex-col gap-6 mx-auto p-6 max-w-3xl">
      <div>
        <h1 className="font-semibold text-2xl">Signaling Service Root Test</h1>

        <p className="text-muted-foreground text-sm">
          Open this page in two browser tabs and join the same room.
        </p>
      </div>

      {error && (
        <div className="p-3 border border-red-500 rounded text-red-500 text-sm">
          {error}
        </div>
      )}

      <section className="p-4 border rounded">
        <h2 className="mb-3 font-semibold">Room</h2>

        <div className="flex flex-col gap-3">
          <input
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={joined}
            className="px-3 py-2 border rounded"
            placeholder="Room ID"
          />

          <div>
            <div className="text-muted-foreground text-xs">Your peer ID</div>

            <code className="text-sm break-all">{peerId || "Not joined"}</code>
          </div>

          {!joined ? (
            <button
              type="button"
              onClick={() => void handleJoinRoom()}
              className="px-4 py-2 border rounded"
            >
              Join Room
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleLeaveRoom()}
              className="px-4 py-2 border rounded"
            >
              Leave Room
            </button>
          )}
        </div>
      </section>

      {joined && (
        <>
          <section className="p-4 border rounded">
            <h2 className="mb-3 font-semibold">Participants</h2>

            {participants.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No other participants.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {participants.map((participant) => (
                  <button
                    key={participant.peerId}
                    type="button"
                    onClick={() => setSelectedPeerId(participant.peerId)}
                    className={`rounded border p-3 text-left ${
                      selectedPeerId === participant.peerId
                        ? "border-primary"
                        : ""
                    }`}
                  >
                    <code className="text-sm break-all">
                      {participant.peerId}
                    </code>

                    <div className="mt-1 text-muted-foreground text-xs">
                      Joined: {participant.joinedAt.toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="p-4 border rounded">
            <h2 className="mb-3 font-semibold">Send Signal</h2>

            <div className="mb-4 text-sm">
              To:{" "}
              <code className="break-all">
                {selectedPeerId || "No participant selected"}
              </code>
            </div>

            <div className="flex flex-col gap-3">
              <input
                value={sdp}
                onChange={(event) => setSdp(event.target.value)}
                placeholder="SDP"
                className="px-3 py-2 border rounded font-mono text-sm"
              />

              <input
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                placeholder="ICE candidate"
                className="px-3 py-2 border rounded font-mono text-sm"
              />

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!selectedPeerId}
                  onClick={() => void handleSendOffer()}
                  className="disabled:opacity-50 px-3 py-2 border rounded"
                >
                  Send Offer
                </button>

                <button
                  type="button"
                  disabled={!selectedPeerId}
                  onClick={() => void handleSendAnswer()}
                  className="disabled:opacity-50 px-3 py-2 border rounded"
                >
                  Send Answer
                </button>

                <button
                  type="button"
                  disabled={!selectedPeerId}
                  onClick={() => void handleSendIceCandidate()}
                  className="disabled:opacity-50 px-3 py-2 border rounded"
                >
                  Send ICE Candidate
                </button>
              </div>
            </div>
          </section>

          <section className="p-4 border rounded">
            <h2 className="mb-3 font-semibold">Received Signals</h2>

            {signals.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No signals received.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {signals.map((signal, index) => (
                  <pre
                    key={index}
                    className="bg-muted p-3 rounded overflow-x-auto text-sm"
                  >
                    {JSON.stringify(signal, null, 2)}
                  </pre>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <section className="p-4 border rounded">
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Events</h2>

          <button
            type="button"
            onClick={() => setEvents([])}
            className="px-3 py-1 border rounded text-xs"
          >
            Clear
          </button>
        </div>

        <div className="bg-muted p-3 rounded max-h-64 overflow-y-auto">
          {events.length === 0 ? (
            <span className="text-muted-foreground text-sm">No events.</span>
          ) : (
            <div className="flex flex-col gap-1">
              {events.map((event, index) => (
                <div key={index} className="font-mono text-xs">
                  {event}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
