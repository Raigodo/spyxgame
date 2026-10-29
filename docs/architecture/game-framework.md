# Game framework

Read before changing how games are defined, started, played or ended, or before writing slot features. The framework is one replicated channel, `game`, a pure play gate, and a host loop. Games plug in through `defineGame`.

## The model

```ts
GameState = {
  round: number;          // +1 each time a game ends
  last?: GameResult;      // outcome of the previous round
  slot: Slot | null;      // null = no game running
}
```

`slot` holds the running game: `{ gameId, version, settings, players, state, seed, ...feature data }`. One slot, one game at a time.

## Commands

One channel, six commands:

| Command    | Who         | Does                                                              |
| ---------- | ----------- | ----------------------------------------------------------------- |
| `start`    | host        | Creates the slot from `settings`, the participant list and a seed |
| `play`     | participant | Runs the game's reducer for a game command                        |
| `observe`  | host        | Folds in facts the host observed (presence, away, time)           |
| `fire`     | host        | A timer elapsed                                                   |
| `continue` | host        | Resume a paused game without its missing players                  |
| `end`      | host        | Clears the slot in the same commit; `round + 1`, `last` set       |

## Play gate

`authorize` runs before any reducer, in this order, and returns the first failing reason:

1. `no-active-game`
2. `wrong-game`
3. `unknown-game`
4. `unknown-command`
5. `paused`
6. `host-only`
7. `not-a-participant`

Then the payload is validated against the game's schema and the reducer runs.

## defineGame

```ts
export const demoTap = defineGame<DemoTapTypes>()({
  id: "demo-tap",
  version: 1,
  settings: s.object({ goal: s.int({ min: 1, max: 1000 }) }),
  state: s.object({ taps: s.record(s.int({ min: 0, max: 1000 }), { max: 200, onInvalid: "drop" }) }),
  commands: { tap: { payload: s.object({}), reduce: (ctx) => ... } },
  features: { presence: true, timers: true },
  init: (ctx) => ({ taps: {} }),
});
```

- **Reducers are pure:** `(state, payload, ctx) -> { state, effects? , private? }`. `ctx` carries the sender, the participants, `now` and the seed-derived random source.
- **Effects** are data: `startTimer`, `cancelTimer`, `emit` (a game event) and `end(result)`. The framework executes them; the reducer never touches a clock.
- **Private patches** go to the owners through the private channel. The public state must not contain secrets a UI is merely trusted to hide.
- **Versioning:** a slot remembers the game `version`; a game supplies `migrate` for older slots after a deploy.
- **Unknown game ids** are kept opaque (`supported: false`), so a host that lacks the game does not destroy the state.

Real examples: `src/games/demo-tap` and `src/games/spy`. Step-by-step: [Creating a game](../guides/creating-a-game.md).

## Slot features

Opt-in modules, each owning `slot.<feature>[key]` and an ordered `observe` step:

| Feature            | Provides                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `presence`         | Which participants are connected and which are `away` (`awayAfterMs`) |
| `pause` / `quorum` | Pause when required players are gone; `continue` resumes without them |
| `timers`           | Named timers on host time; survive failover because they are state    |
| `notices`          | Short messages shown to players (`maxNotices`)                        |
| `private`          | Per-player private pieces                                             |

Each feature is a small module with a schema, an `observe` rule and its limits.

## The host loop

`host-flow.ts` runs only on the host. It watches presence and the clock and issues `observe` and `fire` commands. After each change it repeats until the state settles (at most `maxSettlePasses`). It sleeps until the next boundary (next away deadline or next timer), never less than `minWakeMs`. A new host starts the same loop from the replicated slot, which is why timers and presence work across failover.

## GameHandle

What a game page gets from `room.game`:

```ts
interface GameHandle<T> {
  view: Store<GameView<T>>;               // atomic: slot, me, players, away, notices, supported
  send(command, payload): Promise<Result<void, Reason>>;
  events: Listenable<GameEvent<T>>;       // game events (emit effects)
  noticed: Listenable<Notice>;
  broadcast(event) / sendTo(player, event); // ephemeral, no state
  continueAnyway(): Promise<Result<void, Reason>>;
  local: LocalState;                      // per-device storage for this round
}
```

`local` key: `game-local:<roomId>:<gameId>:<round>:<playerId>:<id>` in the device storage, expiring after `localTtlMs`. Use it for UI memory (what this player has seen), never for shared truth.

## Participants

The set of players in a slot comes from `createGameInputs` in the room layer. Today it is free-for-all: everyone in the roster plays, names come from the roster, and a roster `left` with reason `removed` marks the player removed. Teams, ready checks and invitations are not built.

Settings: [Configuration](../guides/configuration.md#game).
