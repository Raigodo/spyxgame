"use client";

// The lobby's config inputs and Start button for the spy game.

import { useState } from "react";
import type { LobbyStarterProps } from "@/shared/presentation/room/lobby-games";
import { useRoom } from "@/shared/presentation/room/room-provider";
import { spyGame } from "./spy";
import { DEFAULT_SPY_CONFIG, validateSpyConfig } from "./spy-validation";

export function SpyStarter({ disabled, onResult }: LobbyStarterProps) {
  const { client } = useRoom();
  const [wordsPerPlayer, setWordsPerPlayer] = useState(String(DEFAULT_SPY_CONFIG.wordsPerPlayer));
  const [minWords, setMinWords] = useState(String(DEFAULT_SPY_CONFIG.minWords));
  const config = validateSpyConfig({
    wordsPerPlayer: Number(wordsPerPlayer),
    minWords: Number(minWords),
  });

  return (
    <>
      <label className="text-slate-500">Words per player (1-10)</label>
      <input
        className="bg-slate-900 px-2 py-1 border border-slate-700 rounded w-16"
        value={wordsPerPlayer}
        onChange={(e) => setWordsPerPlayer(e.target.value)}
      />
      <label className="text-slate-500">Min words in pool</label>
      <input
        className="bg-slate-900 px-2 py-1 border border-slate-700 rounded w-16"
        value={minWords}
        onChange={(e) => setMinWords(e.target.value)}
      />
      <button
        disabled={disabled || !config}
        className="bg-indigo-700 hover:bg-indigo-600 disabled:opacity-40 px-4 py-2 rounded font-semibold"
        onClick={() => config && void client.startGame(spyGame, config).then(onResult)}
      >
        Start spy
      </button>
    </>
  );
}
