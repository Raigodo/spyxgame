# Creating a game

Read when you add a new game. A game is one `defineGame` definition, one entry in each of two registries, a settings form and a page. Nothing in transport, bus, roster or room changes. The two shipped games are the reference: `src/games/demo-tap` (small) and `src/games/spy` (presence, pause, device-only notes).

## 1. Types and schemas

`src/games/<id>/schemas.ts`. Every schema is network input and needs explicit limits.

```ts
export type TapTypes = GameTypes & {
  settings: { goal: number };
  state: { scores: Record<string, number>; winner?: PlayerId };
  command: { type: "tap" }; // a union discriminated by `type`
  event: { type: "emote"; emoji: string }; // notices and ephemeral events
  reject: "game-over"; // reasons your reducers return
  // private?: ...   mode?: "free-for-all" | "teams"
};
export const settingsSchema: Schema<TapTypes["settings"]> = s.object({
  goal: s.int({ min: 1, max: 1000 }),
});
```

## 2. Definition

`src/games/<id>/definition.ts` (React-free):

```ts
export const demoTap = defineGame<TapTypes>({
  id: "demo-tap",
  modes: ["free-for-all", "teams"],
  players: { min: 1, max: 16 },
  settings: settingsSchema,
  state: stateSchema,
  init: ({ settings, setup, seed }) => initialState(setup.participants),
  commands: {
    tap: { schema: tapSchema, who: "participant", reduce: (a, c) => /* Outcome */ },
  },
  events: { emote: { schema: emoteSchema } },
});
```

- A command type without a handler does not compile. `who` is `participant` (default), `host` or `anyone`.
- `reduce(args, command)` returns `ok({ state, effects?, private? })` or `fail(reason)`. `args` has `state`, `settings`, `setup`, `away`, `seed`, `private`, `sender`. **There is no clock**: time-based behavior is a timer effect.
- Effects: `startTimer { id, timer, afterMs, payload? }`, `cancelTimer { id }`, `emit { event }` (a notice every peer sees once), `end` (finish the game).
- Optional: `timers` (handlers by name), `late` (admit late joiners, else spectators), `presence` (`minPresent`, `belowMin: continue | pause | end`, `rejoin`, `onChange`), `private` (per-player pieces), `version` and `migrate`.
- Keep rules in `rules.ts` as pure functions; the definition only wires them.
- Secrets belong in `private` pieces. Anything in `state` is visible to every client.

## 3. Register

- `src/games/definitions.ts`: add to `GAME_DEFS` (this is `RoomDeps.games`, so the host runs your reducers).
- `src/games/modules.ts`: `defineModule({ def, label, Starter, Page })`.

## 4. Settings form and page

The `Starter` receives `{ disabled, start }` and builds on `StarterForm` and `NumberField` from `@/ui/lobby/starter-form`. The page uses `useGame(def)` (`{ room, handle, view }`), `handle.send({ type: "tap" })`, and the shared pieces in [UI](../architecture/ui.md#writing-a-game-page): `Panel`, `Hint`, `Problem`, `Callout`, `useAnnouncement`.

`view` is `undefined` until the game is active and synced; render "Syncing…" then.

## 5. Check

- Two tabs: start, play, refresh a guest, refresh the host (reclaim), close the host tab (failover). State and timers must survive.
- A reducer you cannot test without a browser is doing too much.

See [Game framework](../architecture/game-framework.md) for the play gate, slot features and the host loop.
