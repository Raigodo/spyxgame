import { useAnnouncement } from "@/ui/game/announcements";
import { Button } from "@/ui/components/ui/button";
import { Hint, Problem } from "@/ui/game/panel";
import { useCommand } from "@/ui/use-command";
import { useGame } from "@/ui/use-game";
import { useStore } from "@/ui/use-store";
import { spyGame } from "./definition";
import { NotesPanel } from "./notes-panel";
import { ClaimButton, PhasePanel, SecretBanner, nameOf, type PanelProps } from "./panels";
import { canForceAdvance, rejectionText, resultText, waitingFor } from "./view";

export function SpyPage() {
  const { room, handle, view } = useGame(spyGame);
  const isHost = useStore(room.role) === "host";
  const { send, error } = useCommand(handle, rejectionText);

  const result = view?.state.result;
  useAnnouncement(
    view && result
      ? {
          key: `result:${view.round}`,
          title: result.winner === "spy" ? "The spy wins" : "The players win",
          description: `${resultText(result.reason)} The word was “${view.state.word}”, the spy was ${
            view.state.spyId ? nameOf(view, view.state.spyId) : "unknown"
          }.`,
        }
      : undefined
  );

  if (!view) return <Hint>Syncing…</Hint>;

  const { state } = view;
  const props: PanelProps = { view, isHost, send: (command) => void send(command) };
  const running = state.phase !== "collecting" && state.phase !== "ended";
  const waiting = running ? waitingFor(state, view.away).map((id) => nameOf(view, id)) : [];

  return (
    <>
      {running && <SecretBanner view={view} />}
      <PhasePanel {...props} />
      {running && <ClaimButton {...props} />}
      {waiting.length > 0 && <Hint>Waiting for {waiting.join(", ")}</Hint>}
      {view.away.length > 0 && (
        <Hint>Away: {view.away.map((id) => nameOf(view, id)).join(", ")}</Hint>
      )}
      {isHost && canForceAdvance(state) && (
        <Button variant="outline" onClick={() => props.send({ type: "forceAdvance" })}>
          Force advance
        </Button>
      )}
      {error && <Problem>{error}</Problem>}
      {view.me.role === "player" && <NotesPanel view={view} handle={handle} />}
    </>
  );
}
