import { Emitter, derived, type PlayerId, type Scope } from "@/kernel";
import type { GameInputs, InputPlayer, SlotSetup } from "@/game";
import type { Roster } from "@/roster";

/** Free-for-all only until the lobby feature exists: everyone who is here plays. */
export function createGameInputs(roster: Roster, scope: Scope): GameInputs {
  const players = derived([roster.state.players], (list): readonly InputPlayer[] =>
    list.map((p) => ({
      id: p.id,
      name: p.name,
      here: p.presence !== "reconnecting",
      ...(p.peerId !== undefined && { peerId: p.peerId }),
    }))
  );
  const setup = derived([players], (list): SlotSetup => ({
    mode: "free-for-all",
    teams: {},
    participants: list.filter((p) => p.here).map((p) => p.id),
    spectators: [],
    names: Object.fromEntries(list.map((p) => [p.id, p.name])),
  }));
  const removed = new Emitter<PlayerId>();
  scope.on(roster.events.left, ({ player, reason }) => {
    if (reason === "removed") removed.emit(player.id);
  });
  return { players, removed, setup };
}
