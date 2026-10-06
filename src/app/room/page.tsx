"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Room ids end up in a Firestore document path and in the URL: keep them simple.
const ROOM_CODE = /^[A-Za-z0-9_-]{3,32}$/;

export default function RoomEntryPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // No playerId in the URL: the room provider mints one per visitor and writes it back.
  function enter(roomId: string) {
    router.push(`/room/${encodeURIComponent(roomId)}`);
  }

  function create() {
    enter(crypto.randomUUID().slice(0, 8));
  }

  function join() {
    const trimmed = code.trim();
    if (!ROOM_CODE.test(trimmed)) {
      setError("Use 3–32 letters, numbers, dashes or underscores.");
      return;
    }
    setError(null);
    enter(trimmed);
  }

  return (
    <div className="flex justify-center items-center bg-slate-950 p-6 min-h-screen text-slate-200 text-sm">
      <div className="space-y-6 w-full max-w-sm">
        <h1 className="font-semibold text-lg">Rooms</h1>

        <section className="space-y-2">
          <button
            className="bg-emerald-700 hover:bg-emerald-600 py-2 rounded w-full font-semibold"
            onClick={create}
          >
            Create a room
          </button>
        </section>

        <section className="space-y-2">
          <label className="block text-slate-500 text-xs uppercase tracking-wide">
            Join with a code
          </label>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-slate-900 px-2 py-1 border border-slate-700 focus:border-slate-500 rounded outline-none"
              placeholder="room code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && join()}
            />
            <button
              className="px-4 py-1 border border-slate-700 hover:border-slate-500 rounded"
              onClick={join}
            >
              Join
            </button>
          </div>
          {error && <p className="text-rose-400 text-xs">{error}</p>}
        </section>
      </div>
    </div>
  );
}
