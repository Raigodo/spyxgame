import { useState } from "react";
import type { GameView } from "@/game";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Callout, Hint, Panel } from "@/ui/game/panel";
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

/** The picked choice is filled, the others outlined. */
const choice = (picked: boolean) => (picked ? "default" : "outline");

export function SecretBanner({ view }: { view: View }) {
  const { state, me } = view;
  if (!canAct(view)) return <Hint>You are watching this round.</Hint>;
  return state.spyId === me.playerId ? (
    <Callout tone="danger">
      <b>You are the spy.</b>
    </Callout>
  ) : (
    <Callout>
      The word is <b>{state.word}</b>
    </Callout>
  );
}

function CollectingPanel({ view, isHost, send }: PanelProps) {
  const [text, setText] = useState("");
  const { state, settings, me } = view;
  const mine = state.words.filter((w) => w.ownerId === me.playerId);
  return (
    <Panel title="Word pool">
      <Hint>
        {state.words.length} of {settings.minWords} words needed. You added {mine.length} of{" "}
        {settings.wordsPerPlayer}.
      </Hint>
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
          <Input
            aria-label="New word"
            placeholder="Add a word"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" variant="outline" size="lg">
            Add
          </Button>
        </form>
      )}
      {mine.length > 0 && (
        <ul className="space-y-1 text-sm">
          {mine.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{w.text}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => send({ type: "removeWord", wordId: w.id })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {isHost && (
        <Button
          size="lg"
          className="w-full"
          disabled={state.words.length < settings.minWords}
          onClick={() => send({ type: "begin" })}
        >
          Begin round
        </Button>
      )}
    </Panel>
  );
}

function TalkingPanel({ view, isHost, send }: PanelProps) {
  const { state, me } = view;
  const speaker = currentSpeakerId(state);
  return (
    <Panel title={`Talking, circle ${state.circle}`}>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {state.order.map((id) => (
          <li key={id} className={id === speaker ? "font-semibold" : "text-muted-foreground"}>
            {nameOf(view, id)}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        {speaker === me.playerId && (
          <Button onClick={() => send({ type: "endTurn" })}>End my turn</Button>
        )}
        {isHost && (
          <Button variant="outline" onClick={() => send({ type: "skipTurn" })}>
            Skip turn
          </Button>
        )}
      </div>
    </Panel>
  );
}

function DecidingPanel({ view, send }: PanelProps) {
  const mine = view.state.decisions[view.me.playerId];
  return (
    <Panel title="Time to vote?">
      {canAct(view) ? (
        <div className="flex gap-2">
          <Button
            variant={choice(mine === "vote")}
            onClick={() => send({ type: "decide", choice: "vote" })}
          >
            Vote now
          </Button>
          <Button
            variant={choice(mine === "continue")}
            onClick={() => send({ type: "decide", choice: "continue" })}
          >
            Talk more
          </Button>
        </div>
      ) : (
        <Hint>Players are deciding.</Hint>
      )}
    </Panel>
  );
}

function VotingPanel({ view, send }: PanelProps) {
  const { state, me } = view;
  const mine = state.votes[me.playerId];
  return (
    <Panel title="Who is the spy?">
      {canAct(view) ? (
        <div className="flex flex-wrap gap-2">
          {state.order
            .filter((id) => id !== me.playerId)
            .map((id) => (
              <Button
                key={id}
                variant={choice(mine === id)}
                onClick={() => send({ type: "vote", target: id })}
              >
                {nameOf(view, id)}
              </Button>
            ))}
        </div>
      ) : (
        <Hint>Players are voting.</Hint>
      )}
    </Panel>
  );
}

function LastChancePanel({ view, send }: PanelProps) {
  const { state, me } = view;
  return (
    <Panel title="Last chance">
      <p className="text-sm">
        {state.accusedId && nameOf(view, state.accusedId)} was accused, and is the spy.
      </p>
      {state.spyId === me.playerId ? (
        <Button variant="outline" onClick={() => send({ type: "giveUp" })}>
          Give up
        </Button>
      ) : (
        <Hint>The spy can still claim to know the word.</Hint>
      )}
    </Panel>
  );
}

function ClaimPanel({ view, send }: PanelProps) {
  const { state, me } = view;
  const claim = state.claim;
  if (!claim) return null;
  const judge = canAct(view) && state.spyId !== me.playerId;
  const mine = claim.votes[me.playerId];
  return (
    <Panel title="The spy claims to know the word">
      {judge ? (
        <>
          <p className="text-sm">Was the spoken word correct?</p>
          <div className="flex gap-2">
            <Button
              variant={choice(mine === true)}
              onClick={() => send({ type: "claimVote", correct: true })}
            >
              Correct
            </Button>
            <Button
              variant={choice(mine === false)}
              onClick={() => send({ type: "claimVote", correct: false })}
            >
              Wrong
            </Button>
          </div>
        </>
      ) : (
        <Hint>The others are judging.</Hint>
      )}
    </Panel>
  );
}

function EndedPanel({ view }: PanelProps) {
  const { state } = view;
  const result = state.result;
  return (
    <Panel title="Round over">
      {result && (
        <>
          <p className="text-sm font-medium">
            {result.winner === "spy" ? "The spy wins" : "The players win"}
          </p>
          <Hint>{resultText(result.reason)}</Hint>
        </>
      )}
      <p className="text-sm">
        Word: <b>{state.word}</b> · Spy: <b>{state.spyId && nameOf(view, state.spyId)}</b>
      </p>
    </Panel>
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
    <Button variant="outline" onClick={() => send({ type: "claimWord" })}>
      I know the word
    </Button>
  );
}
