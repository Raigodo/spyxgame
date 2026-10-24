// Pure projections of a demo-tap view for its page: who leads, and team totals in teams mode.

import type { GameView } from "@/game";
import type { PlayerId } from "@/kernel";
import type { TapTypes } from "./schemas";

export type Standing = { id: PlayerId; name: string; score: number; team?: string; away: boolean };

/** Participants by score, highest first (ties keep join order). */
export function standings(view: GameView<TapTypes>): Standing[] {
  const teams = view.setup.mode === "teams" ? view.setup.teams : undefined;
  return view.players
    .filter((p) => p.role === "player")
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: view.state.scores[p.id] ?? 0,
      away: p.away,
      ...(teams?.[p.id] !== undefined && { team: teams[p.id] }),
    }))
    .sort((a, b) => b.score - a.score);
}

/** Teams mode only: total taps per team, highest first. */
export function teamTotals(
  view: GameView<TapTypes>
): { team: string; total: number }[] | undefined {
  if (view.setup.mode !== "teams") return undefined;
  const totals = new Map<string, number>(view.setup.teamIds.map((team) => [team, 0]));
  for (const row of standings(view)) {
    if (row.team !== undefined) totals.set(row.team, (totals.get(row.team) ?? 0) + row.score);
  }
  return Array.from(totals, ([team, total]) => ({ team, total })).sort((a, b) => b.total - a.total);
}
