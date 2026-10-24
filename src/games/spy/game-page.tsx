import { useCommand } from "@/ui/use-command";
import { useGame } from "@/ui/use-game";
import { useStore } from "@/ui/use-store";
import { btn, errorText } from "@/ui/styles";
import { spyGame } from "./definition";
import { NotesPanel } from "./notes-panel";
import { ClaimButton, PhasePanel, SecretBanner, nameOf, type PanelProps } from "./panels";
import { canForceAdvance, rejectionText, waitingFor } from "./view";

export function SpyPage() {
  const { room, handle, view } = useGame(spyGame);
  const isHost = useStore(room.role) === "host";
  const { send, error } = useCommand(handle, rejectionText);

  if (!view) return <p className="text-slate-500">Syncing…</p>;

  const { state } = view;
  const props: PanelProps = { view, isHost, send: (command) => void send(command) };
  const running = state.phase !== "collecting" && state.phase !== "ended";
  const waiting = running ? waitingFor(state, view.away).map((id) => nameOf(view, id)) : [];

  return (
    <>
      {running && <SecretBanner view={view} />}
      <PhasePanel {...props} />
      {running && <ClaimButton {...props} />}
      {waiting.length > 0 && <p className="text-slate-400">Waiting for {waiting.join(", ")}</p>}
      {view.away.length > 0 && (
        <p className="text-amber-400">Away: {view.away.map((id) => nameOf(view, id)).join(", ")}</p>
      )}
      {isHost && canForceAdvance(state) && (
        <button className={btn} onClick={() => props.send({ type: "forceAdvance" })}>
          Force advance
        </button>
      )}
      {error && <p className={errorText}>{error}</p>}
      {view.me.role === "player" && <NotesPanel view={view} handle={handle} />}
    </>
  );
}
