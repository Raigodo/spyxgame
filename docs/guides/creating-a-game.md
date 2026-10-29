# Creating a game

Read when you add a new game. A game is one `defineGame` definition, one registry line per registry, and one page. Nothing in transport, bus, roster or room changes.

## 1. Define it

Create `src/games/<id>/definition.ts` (React-free):

```ts
import { defineGame, s } from "@/game";

export const myGame = defineGame<MyTypes>()({
  id: "my-game",
  version: 1,
  settings: s.object({ goal: s.int({ min: 1, max: 100 }) }),
  state: s.object({
    score: s.record(s.int({ min: 0, max: 100 }), { max: 200, onInvalid: "drop" }),
  }),
  commands: {
    score: {
      payload: s.object({}),
      reduce: ({ state, sender }) => ({ state: bump(state, sender) }),
    },
  },
  features: { presence: true },
  init: () => ({ score: {} }),
});
```

Rules:

- **Reducers are pure.** No `Date.now`, no `Math.random`, no storage. Time comes from `ctx.now`, randomness from the seeded source on `ctx`.
- **Every schema has explicit limits.** Everything a peer can send is validated.
- **Secrets are private pieces,** not public state. Return them as private patches.
- **Time-based behavior is a timer effect** (`startTimer`, `cancelTimer`). When it fires, a `fire` command runs your reducer, on any host.
- Finish with `{ effects: [{ type: "end", result }] }`; the framework clears the slot and bumps `round`.

Change the state shape later: bump `version` and add `migrate`.

## 2. Register it

- `src/games/definitions.ts`: add to `GAME_DEFS` (this is what `RoomDeps.games` uses, so host logic runs).
- `src/games/modules.ts`: add a module with label, `Starter` (settings form) and `Page`.

## 3. Write the page

```tsx
const game = useGame(myGame);                  // GameHandle
const view = useStore(game.view);
game.send("score", {}).then((r) => { if (!r.ok) ... });
```

Show `view.supported === false` as "this game is not available here". Disable buttons while `room.sync` is not `ready`.

## 4. Check

- Two tabs: start, play, refresh the guest, refresh the host (reclaim), close the host tab (failover). State and timers must survive.
- A reducer you cannot test without a browser is doing too much.

See [Game framework](../architecture/game-framework.md) for gate order, slot features and the host loop.
