"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CommandResult } from "@/shared/application/messaging";
import { ChatPanel } from "@/shared/presentation/room/chat-panel";
import {
  useGameHandle,
  useGameValue,
  useIsHost,
  usePlayers,
  useRoomStatus,
} from "@/shared/presentation/room/room-hooks";
import { useRoom } from "@/shared/presentation/room/room-provider";
import { currentSpeakerId, MAX_WORD_LENGTH, nonSpyIds } from "@/spy/spy-rules";
import { spyGame } from "@/spy/spy";
import { SpyNotesPanel } from "@/spy/spy-notes-panel";
import { canForceAdvance, rejectionText, resultText, waitingFor } from "@/spy/spy-view";
import { shortId } from "@/shared/kernel";
import { spyNotes } from "@/spy/spy-notes";

const btn = "disabled:opacity-40 px-3 py-1 rounded font-semibold";

export default function SpyPage() {
  const router = useRouter();
  const { client } = useRoom();
  const game = useGameHandle(spyGame);
  const players = usePlayers();
  const isHost = useIsHost();
  const syncing = useRoomStatus() !== "ready";

  const state = useGameValue(game, () => game.getState());
  const config = useGameValue(game, () => game.getConfig());
  const role = useGameValue(game, () => game.getRole());
  const away = useGameValue(game, () => game.getAway());
  const paused = useGameValue(game, () => game.isPaused());
  const notesHandle = game.local(spyNotes);
  const notes = useGameValue(notesHandle, () => notesHandle.get());
  const gamePlayers = useGameValue(game, () => game.getPlayers());

  const [notice, setNotice] = useState<string | null>(null);
  const [wordInput, setWordInput] = useState("");
  const [showPool, setShowPool] = useState(true);

  const me = players.find((p) => p.peerId === client.getLocalPeerId())?.playerId;
  const nameOf = (playerId: string) =>
    gamePlayers.find((p) => p.playerId === playerId)?.name ?? shortId(playerId);

  async function act(run: () => Promise<CommandResult>) {
    const result = await run();
    setNotice(result.ok ? null : rejectionText(result.reason));
    return result.ok;
  }

  async function addWord() {
    if (await act(() => game.sendCommand("addWord", { text: wordInput }))) setWordInput("");
  }

  // The room is "in-game" a moment before the game's own state arrives.
  if (!state || !config) {
    return <div className="bg-slate-950 p-6 min-h-screen text-slate-200">Starting game…</div>;
  }

  const isPlayer = role === "player" && me !== undefined;
  const isSpy = isPlayer && state.spyId === me;
  const playing = state.phase !== "collecting" && state.phase !== "ended";
  const speaker = currentSpeakerId(state);
  const waiting = waitingFor(state, away);
  const myWords = state.words.filter((w) => w.ownerId === me);
  const roundPlayers = (
    state.order.length > 0 ? state.order : gamePlayers.map((p) => p.playerId)
  ).map((playerId) => ({ playerId, name: nameOf(playerId) }));

  return (
    <div className="bg-slate-950 p-6 min-h-screen text-slate-200 text-sm">
      <div className="space-y-4 mx-auto max-w-2xl">
        <header className="flex justify-between items-center">
          <div className="space-y-1">
            <h1 className="font-semibold text-lg">Spy</h1>
            <p className="text-slate-500 text-xs">
              You are {isPlayer ? "playing" : "spectating"}
              {playing && ` · circle ${state.circle}`}
            </p>
          </div>
          <div className="flex gap-2">
            {isHost && (
              <button
                disabled={syncing}
                className={`bg-amber-700 ${btn}`}
                onClick={() => void client.endGame()}
              >
                End game
              </button>
            )}
            <button className="bg-rose-900 px-3 py-1 rounded" onClick={() => router.push("/room")}>
              Leave room
            </button>
          </div>
        </header>

        {notice && (
          <p className="bg-rose-950 p-2 border border-rose-800 rounded text-rose-300">{notice}</p>
        )}

        {away.length > 0 && (
          <p className="bg-amber-950 p-2 border border-amber-800 rounded text-amber-300 text-xs">
            Away: {away.map(nameOf).join(", ")}. Their turns and votes are skipped. They can rejoin.
          </p>
        )}
        {paused && (
          <div className="flex items-center gap-2 bg-amber-950 p-2 border border-amber-800 rounded text-amber-300">
            <span>Paused: too few players are here.</span>
            {isHost && (
              <button
                disabled={syncing}
                className={`border border-amber-700 ${btn}`}
                onClick={() => void act(() => game.continueAnyway())}
              >
                Continue anyway
              </button>
            )}
          </div>
        )}

        {/* The word or the spy role. Only the player themself sees it. */}
        {playing && isPlayer && (
          <p className="bg-slate-900 p-3 border border-slate-700 rounded text-lg text-center">
            {isSpy ? (
              <span className="font-bold text-rose-400">You are the SPY</span>
            ) : (
              <>
                The word is <span className="font-bold text-emerald-300">{state.word}</span>
              </>
            )}
          </p>
        )}

        {state.claim && (
          <p className="bg-amber-950 p-3 border border-amber-800 rounded text-amber-200">
            The spy says they know the word. Listen in the call, then vote.
          </p>
        )}

        {/* ─── Collecting ─── */}
        {state.phase === "collecting" && (
          <section className="space-y-2">
            <h2 className="text-slate-500 text-xs uppercase tracking-wide">
              Word pool · {state.words.length} (need {config.minWords}) · up to{" "}
              {config.wordsPerPlayer} each
            </h2>
            {isPlayer && (
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-slate-900 px-2 py-1 border border-slate-700 rounded"
                  placeholder="Add a word"
                  maxLength={MAX_WORD_LENGTH}
                  value={wordInput}
                  onChange={(e) => setWordInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addWord()}
                />
                <button
                  disabled={syncing || wordInput.trim() === ""}
                  className={`bg-indigo-700 ${btn}`}
                  onClick={() => void addWord()}
                >
                  Add
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {myWords.map((w) => (
                <button
                  key={w.id}
                  disabled={syncing}
                  title="Remove"
                  className="disabled:opacity-40 px-2 py-0.5 border border-indigo-700 rounded"
                  onClick={() => void act(() => game.sendCommand("removeWord", { wordId: w.id }))}
                >
                  {w.text} ✕
                </button>
              ))}
            </div>
            <button className="text-slate-500 text-xs" onClick={() => setShowPool((v) => !v)}>
              {showPool ? "Hide" : "Show"} everyone&apos;s words
            </button>
            {showPool && (
              <ul className="text-slate-400">
                {state.words
                  .filter((w) => w.ownerId !== me)
                  .map((w) => (
                    <li key={w.id}>
                      {w.text} <span className="text-slate-600">· {nameOf(w.ownerId)}</span>
                    </li>
                  ))}
              </ul>
            )}
            {isHost && (
              <button
                disabled={syncing || state.words.length < config.minWords}
                className={`bg-emerald-700 ${btn}`}
                onClick={() =>
                  void act(() =>
                    game.sendCommand("begin", {
                      seed: crypto.getRandomValues(new Uint32Array(1))[0] as number,
                    })
                  )
                }
              >
                Begin round
              </button>
            )}
          </section>
        )}

        {/* ─── Talking ─── */}
        {state.phase === "talking" && !state.claim && (
          <section className="space-y-2">
            <h2 className="text-slate-500 text-xs uppercase tracking-wide">Speaking order</h2>
            <ol className="space-y-0.5">
              {state.order.map((id, i) => (
                <li
                  key={id}
                  className={id === speaker ? "font-bold text-emerald-300" : "text-slate-400"}
                >
                  {i + 1}. {nameOf(id)}
                  {id === speaker && " ← speaking"}
                  {away.includes(id) && " (away)"}
                </li>
              ))}
            </ol>
            {speaker === me && (
              <button
                disabled={syncing}
                className={`bg-indigo-700 ${btn}`}
                onClick={() => void act(() => game.sendCommand("endTurn", {}))}
              >
                I&apos;m done speaking
              </button>
            )}
            {isHost && speaker !== me && (
              <button
                disabled={syncing}
                className={`border border-slate-700 ${btn}`}
                onClick={() => void act(() => game.sendCommand("skipTurn", {}))}
              >
                Skip {speaker && nameOf(speaker)}
              </button>
            )}
          </section>
        )}

        {/* ─── Deciding ─── */}
        {state.phase === "deciding" && !state.claim && (
          <section className="space-y-2">
            <h2 className="text-slate-500 text-xs uppercase tracking-wide">
              Circle over: go to voting?
            </h2>
            {isPlayer && (
              <div className="flex gap-2">
                {(["vote", "continue"] as const).map((choice) => (
                  <button
                    key={choice}
                    disabled={syncing}
                    className={`${btn} ${
                      state.decisions[me] === choice ? "bg-indigo-600" : "border border-slate-700"
                    }`}
                    onClick={() => void act(() => game.sendCommand("decide", { choice }))}
                  >
                    {choice === "vote" ? "Vote now" : "Another circle"}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ─── Voting ─── */}
        {state.phase === "voting" && !state.claim && (
          <section className="space-y-2">
            <h2 className="text-slate-500 text-xs uppercase tracking-wide">Who is the spy?</h2>
            {isPlayer &&
              state.order
                .filter((id) => id !== me)
                .map((id) => (
                  <button
                    key={id}
                    disabled={syncing}
                    className={`block ${btn} ${
                      state.votes[me] === id ? "bg-indigo-600" : "border border-slate-700"
                    }`}
                    onClick={() => void act(() => game.sendCommand("vote", { target: id }))}
                  >
                    {nameOf(id)}
                  </button>
                ))}
          </section>
        )}

        {/* ─── Last chance ─── */}
        {state.phase === "lastChance" && !state.claim && state.accusedId && (
          <section className="space-y-2">
            <p>
              {nameOf(state.accusedId)} was accused, and is the spy.{" "}
              {isSpy
                ? "Say the word in the call, then press the claim button, or give up."
                : "The spy has one last chance to say the word."}
            </p>
            {isSpy && (
              <button
                disabled={syncing}
                className={`border border-rose-800 ${btn}`}
                onClick={() => void act(() => game.sendCommand("giveUp", {}))}
              >
                Give up
              </button>
            )}
          </section>
        )}

        {/* ─── Claim vote (non-spies) ─── */}
        {state.claim && isPlayer && !isSpy && (
          <section className="flex gap-2">
            {([true, false] as const).map((correct) => (
              <button
                key={String(correct)}
                disabled={syncing}
                className={`${btn} ${
                  state.claim?.votes[me] === correct ? "bg-indigo-600" : "border border-slate-700"
                }`}
                onClick={() => void act(() => game.sendCommand("claimVote", { correct }))}
              >
                {correct ? "The word was correct" : "The word was wrong"}
              </button>
            ))}
          </section>
        )}

        {/* ─── Spy claim button ─── */}
        {playing && !state.claim && isSpy && (
          <button
            disabled={syncing}
            className={`bg-rose-800 ${btn}`}
            onClick={() => void act(() => game.sendCommand("claimWord", {}))}
          >
            I know the word (say it in the call first)
          </button>
        )}

        {/* ─── Waiting and host override ─── */}
        {playing && waiting.length > 0 && (
          <p className="text-slate-500 text-xs">Waiting for: {waiting.map(nameOf).join(", ")}</p>
        )}
        {isHost && canForceAdvance(state) && (
          <button
            disabled={syncing}
            className={`border border-slate-700 ${btn}`}
            title="Resolve with the answers given so far"
            onClick={() => void act(() => game.sendCommand("forceAdvance", {}))}
          >
            Don&apos;t wait: continue now
          </button>
        )}

        {/* ─── Result ─── */}
        {state.phase === "ended" && state.result && (
          <section className="space-y-1 bg-emerald-950 p-3 border border-emerald-800 rounded text-emerald-200">
            <p className="font-bold text-base">
              {state.result.winner === "spy" ? "The spy wins!" : "The players win!"}
            </p>
            <p>{resultText(state.result.reason)}</p>
            <p>
              The spy was {state.spyId && nameOf(state.spyId)}. The word was{" "}
              <span className="font-bold">{state.word}</span>.
            </p>
            <p className="text-emerald-400 text-xs">
              Non-spies this round: {nonSpyIds(state).map(nameOf).join(", ")}
            </p>
          </section>
        )}

        {isPlayer && (
          <SpyNotesPanel
            notes={notes}
            onChange={(next) => notesHandle.set(next)}
            players={roundPlayers.filter((p) => p.playerId !== me)}
          />
        )}

        <ChatPanel />
      </div>
    </div>
  );
}
