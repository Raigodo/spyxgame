"use client";

// The lobby's config inputs and Start button for the tap race.

import { useState } from "react";
import type { LobbyStarterProps } from "@/shared/presentation/room/lobby-games";
import { useRoom } from "@/shared/presentation/room/room-provider";
import { demoTap } from "./demo-tap";

export function DemoTapStarter({ disabled, onResult }: LobbyStarterProps) {
  const { client } = useRoom();
  const [goalInput, setGoalInput] = useState("20");
  const config = demoTap.spec.validateConfig({ goal: Number(goalInput) });

  return (
    <>
      <label className="text-slate-500">Goal</label>
      <input
        className="bg-slate-900 px-2 py-1 border border-slate-700 rounded w-20"
        value={goalInput}
        onChange={(e) => setGoalInput(e.target.value)}
      />
      <button
        disabled={disabled || !config}
        className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 rounded font-semibold"
        onClick={() => config && void client.startGame(demoTap, config).then(onResult)}
      >
        Start tap race
      </button>
    </>
  );
}
