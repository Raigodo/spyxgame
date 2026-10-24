// Tap race. Both lobby modes (the page computes team totals from `setup.teams`), an ephemeral emote
// event, and late joiners admitted in free-for-all but not in teams (no team to put them on).

import { defineGame } from "@/game";
import { ok } from "@/kernel";
import { admitLate, initialState, tap } from "./rules";
import {
  MAX_PLAYERS,
  emoteSchema,
  settingsSchema,
  stateSchema,
  tapSchema,
  type TapTypes,
} from "./schemas";

export const demoTap = defineGame<TapTypes>({
  id: "demo-tap",
  modes: ["free-for-all", "teams"],
  players: { min: 1, max: MAX_PLAYERS },
  settings: settingsSchema,
  state: stateSchema,
  init: ({ setup }) => initialState(setup.participants),

  commands: {
    tap: {
      schema: tapSchema,
      reduce: (a) => {
        const result = tap(a.state, a.sender.playerId, a.settings.goal);
        return result.ok ? ok({ state: result.value }) : result;
      },
    },
  },

  events: { emote: { schema: emoteSchema } },

  late: (a) => (a.setup.mode === "teams" ? undefined : { state: admitLate(a.state, a.playerId) }),
});
