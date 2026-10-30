# Game framework

Read before changing how games are started, played or ended, or before writing slot features. The framework is one replicated channel, `game`, a pure play gate and a host loop. Games plug in through `defineGame` (see [Creating a game](../guides/creating-a-game.md)).

## The model

```ts
GameState = {
  round: number;                          // +1 each time a game ends
  last?: { gameId; settings };            // what ran last (no result: a game keeps its own)
  slot: Slot | null;                      // null = no game running
}
Slot = { gameId, version, seed, settings, state, setup, x }   // x: slot features by key
```

One slot, one game at a time. An unknown game id is kept opaque (`supported: false`), so a host that lacks the game does not destroy the state. A slot remembers the game `version`; a game supplies `migrate` for older ones.

## Commands

One channel, six internal commands: `start` (host, with a seed from the Entropy port), `play` (a game command), `observe` (the host folds in presence and removals), `fire` (a timer elapsed), `continue` (resume a paused game), `end` (clears the slot in the same commit: `round + 1`, `last` set).

## Play gate

`authorize` runs before any reducer and returns the first failing reason:

1. `no-active-game`
2. `wrong-game`
3. `unknown-game`
4. `unknown-command`
5. `paused` (unless the command is `who: "host"`)
6. `host-only` (for `who: "host"`)
7. `not-a-participant` (for `who: "participant"`)

Then the payload is validated against the command schema (`invalid`) and the reducer runs.

## Reducers and effects

Reducers are pure and have no clock. A reduction is `{ state, effects?, private? }`. Effects are data the framework executes:

| Effect                       | Does                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `startTimer` / `cancelTimer` | Named timer on host time. Timers are state, so they survive failover            |
| `emit`                       | A notice, stored in the slot (newest `maxNotices`) and shown once on every peer |
| `end`                        | Finish the game after this reduction                                            |

`private` is `playerId -> piece | null`, delivered to its owner through the private channel before the state that refers to it is broadcast.

## Slot features

Each owns `slot.x[key]`, parses its own network input, applies its own effects, and optionally has an ordered `observe` step. They are `presence` (away, pause, `minPresent`), `timers`, `notices`, `private`. Adding one means a new file in `game/slot/` registered in `slot/index.ts`.

## The host loop

`host-flow.ts` runs only on the host. It watches players, links and the clock and issues `observe` and `fire`. After each change it repeats until the state settles (at most `maxSettlePasses`), then sleeps until the next away boundary or timer (never less than `minWakeMs`). A new host starts the same loop from the replicated slot.

## Client API

```ts
room.game.state.{ active, last, round }          // stores
room.game.actions.start(def, settings) / end()   // host
const handle = room.game.actions.handle(def);    // same object for the same def
handle.view                // Store<GameView | undefined>: round, settings, state, setup, me, players, away, paused, notices, timers
handle.send(command)       // Result: the game's own reasons, play-gate reasons, bus failures
handle.noticed             // each notice once, from state, on every peer (never replays on subscribe)
handle.events              // ephemeral events from handle.broadcast / sendTo
handle.continueAnyway()    // host, while paused
handle.local(def)          // device-only value per round and player
```

`local` is stored under `game-local:<roomId>:<gameId>:<round>:<playerId>:<id>` in the device storage and expires after `localTtlMs`. Use it for notes and UI memory, never for shared truth.

## Participants

`createGameInputs` (room layer) feeds the game from the roster. Today it is free-for-all: everyone in the roster plays, names come from the roster, and a roster `left` with reason `removed` marks the player removed. Teams, ready checks and lobby chat are not built.

Settings: [Configuration](../guides/configuration.md#game).
