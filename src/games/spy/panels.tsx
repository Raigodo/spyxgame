import { useState } from "react";
import type { GameView } from "@/game";
import { btn, btnPrimary, card, heading, input } from "@/ui/styles";
import { currentSpeakerId } from "./rules";
import type { SpyCommand, SpyTypes } from "./schemas";
import { resultText } from "./view";

type View = GameView<SpyTypes>;
export interface PanelProps {
  view: View;
  isHost: boolean;
  send(command: SpyCommand): void;
}

export const nameOf = (view: View, id: string): string =>
  view.players.find((p) => p.id === id)?.name ?? id;
const canAct = (view: View): boolean => view.me.role === "player";

export function SecretBanner({ view }: { view: View }) {
  const { state, me } = view;
  if (!canAct(view)) return <p className="text-slate-400">You are watching this round.</p>;
  return state.spyId === me.playerId ? (
    <p className="p-3 border border-rose-800 rounded font-semibold text-rose-300">
      You are the spy.
    </p>
  ) : (
    <p className="p-3 border border-emerald-800 rounded">
      The word is <b>{state.word}</b>
    </p>
  );
}

function CollectingPanel({ view, isHost, send }: PanelProps) {
  const [text, setText] = useState("");
  const { state, settings, me } = view;
  const mine = state.words.filter((w) => w.ownerId === me.playerId);
  return (
    <section className={card}>
      <h2 className={heading}>Word pool</h2>
      <p>
        {state.words.length} of {settings.minWords} words needed. You added {mine.length} of{" "}
        {settings.wordsPerPlayer}.
      </p>
      {canAct(view) && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            send({ type: "addWord", text });
            setText("");
          }}
        >
          <input
            className={`${input} flex-1`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className={btn}>Add</button>
        </form>
      )}
      <ul className="space-y-1">
        {mine.map((w) => (
          <li key={w.id} className="flex justify-between items-center">
            <span>{w.text}</span>
            <button className={btn} onClick={() => send({ type: "removeWord", wordId: w.id })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {isHost && (
        <button
          className={btnPrimary}
          disabled={state.words.length < settings.minWords}
          onClick={() => send({ type: "begin" })}
        >
          Begin round
        </button>
      )}
    </section>
  );
}

function TalkingPanel({ view, isHost, send }: PanelProps) {
  const { state, me } = view;
  const speaker = currentSpeakerId(state);
  return (
    <section className={card}>
      <h2 className={heading}>Talking, circle {state.circle}</h2>
      <ol className="space-y-1 pl-5 list-decimal">
        {state.order.map((id) => (
          <li key={id} className={id === speaker ? "font-semibold text-emerald-400" : ""}>
            {nameOf(view, id)}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        {speaker === me.playerId && (
          <button className={btnPrimary} onClick={() => send({ type: "endTurn" })}>
            End my turn
          </button>
        )}
        {isHost && (
          <button className={btn} onClick={() => send({ type: "skipTurn" })}>
            Skip turn
          </button>
        )}
      </div>
    </section>
  );
}

function DecidingPanel({ view, send }: PanelProps) {
  const mine = view.state.decisions[view.me.playerId];
  return (
    <section className={card}>
      <h2 className={heading}>Time to vote?</h2>
      {canAct(view) ? (
        <div className="flex gap-2">
          <button
            className={mine === "vote" ? btnPrimary : btn}
            onClick={() => send({ type: "decide", choice: "vote" })}
          >
            Vote now
          </button>
          <button
            className={mine === "continue" ? btnPrimary : btn}
            onClick={() => send({ type: "decide", choice: "continue" })}
          >
            Talk more
          </button>
        </div>
      ) : (
        <p className="text-slate-400">Players are deciding.</p>
      )}
    </section>
  );
}

function VotingPanel({ view, send }: PanelProps) {
  const { state, me } = view;
  const mine = state.votes[me.playerId];
  return (
    <section className={card}>
      <h2 className={heading}>Who is the spy?</h2>
      {canAct(view) ? (
        <div className="flex flex-wrap gap-2">
          {state.order
            .filter((id) => id !== me.playerId)
            .map((id) => (
              <button
                key={id}
                className={mine === id ? btnPrimary : btn}
                onClick={() => send({ type: "vote", target: id })}
              >
                {nameOf(view, id)}
              </button>
            ))}
        </div>
      ) : (
        <p className="text-slate-400">Players are voting.</p>
      )}
    </section>
  );
}

function LastChancePanel({ view, send }: PanelProps) {
  const { state, me } = view;
  return (
    <section className={card}>
      <h2 className={heading}>Last chance</h2>
      <p>{state.accusedId && nameOf(view, state.accusedId)} was accused, and is the spy.</p>
      {state.spyId === me.playerId ? (
        <button className={btn} onClick={() => send({ type: "giveUp" })}>
          Give up
        </button>
      ) : (
        <p className="text-slate-400">The spy can still claim to know the word.</p>
      )}
    </section>
  );
}

function ClaimPanel({ view, send }: PanelProps) {
  const { state, me } = view;
  const claim = state.claim;
  if (!claim) return null;
  const judge = canAct(view) && state.spyId !== me.playerId;
  const mine = claim.votes[me.playerId];
  return (
    <section className={card}>
      <h2 className={heading}>The spy claims to know the word</h2>
      {judge ? (
        <div className="space-y-2">
          <p>Was the spoken word correct?</p>
          <div className="flex gap-2">
            <button
              className={mine === true ? btnPrimary : btn}
              onClick={() => send({ type: "claimVote", correct: true })}
            >
              Correct
            </button>
            <button
              className={mine === false ? btnPrimary : btn}
              onClick={() => send({ type: "claimVote", correct: false })}
            >
              Wrong
            </button>
          </div>
        </div>
      ) : (
        <p className="text-slate-400">The others are judging.</p>
      )}
    </section>
  );
}

function EndedPanel({ view }: PanelProps) {
  const { state } = view;
  const result = state.result;
  return (
    <section className={card}>
      <h2 className={heading}>Round over</h2>
      {result && (
        <>
          <p className="font-semibold">
            {result.winner === "spy" ? "The spy wins" : "The players win"}
          </p>
          <p>{resultText(result.reason)}</p>
        </>
      )}
      <p>
        Word: <b>{state.word}</b> · Spy: <b>{state.spyId && nameOf(view, state.spyId)}</b>
      </p>
    </section>
  );
}

export function PhasePanel(props: PanelProps) {
  const { state } = props.view;
  if (state.phase === "ended") return <EndedPanel {...props} />;
  if (state.claim) return <ClaimPanel {...props} />;
  switch (state.phase) {
    case "collecting":
      return <CollectingPanel {...props} />;
    case "talking":
      return <TalkingPanel {...props} />;
    case "deciding":
      return <DecidingPanel {...props} />;
    case "voting":
      return <VotingPanel {...props} />;
    case "lastChance":
      return <LastChancePanel {...props} />;
  }
}

/** The spy's "I know the word", while a round runs and no claim is pending. */
export function ClaimButton({ view, send }: PanelProps) {
  const { state, me } = view;
  if (state.claim || state.spyId !== me.playerId) return null;
  return (
    <button className={btn} onClick={() => send({ type: "claimWord" })}>
      I know the word
    </button>
  );
}
