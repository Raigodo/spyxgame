# Using the room API

Read when you build UI or any code on top of `Room`. All state is stores, all moments are listenables, all actions return `Result`.

## Join and leave

```ts
const deps = getRoomDeps();
const joined = await joinRoom(deps, { roomId, playerId, nickname }); // playerId and nickname optional
if (!joined.ok) return showUnavailable();
const { room, generated } = joined.value;
if (generated) deps.storages.tab.set(`player-id:${roomId}`, room.playerId); // a refresh keeps the player
// ...
await room.leave(); // idempotent
```

## Reading state

```ts
room.roster.state.players.get();
const off = room.roster.state.players.subscribe((players) => ...);
```

In React, use `useStore(store)` (it wraps `useSyncExternalStore`). A store returns a **stable reference until the value really changes**, so it is safe as a dependency.

Moments, not state:

```ts
const off = room.roster.events.joined.on((player) => { ... });
// also: rejoined, left ({ player, reason: "expired" | "removed" }), refused
```

## Acting

```ts
const r = await room.roster.actions.kick(id);
if (!r.ok) show(r.reason); // "not-host" | "unknown-player" | ...
```

Intents never throw for expected failures. Handle `r.reason`.

## Game

```ts
await room.game.actions.start(demoTap, { goal: 20 });
const handle = room.game.actions.handle(demoTap);
handle.view.get(); // undefined, or { round, settings, state, setup, me, players, away, paused, notices, timers }
await handle.send({ type: "tap" });
```

## Connection states

| `room.sync` | Show                                  |
| ----------- | ------------------------------------- |
| `ready`     | Normal                                |
| `syncing`   | "Syncing..." and disable actions      |
| `lost`      | "Reconnecting..." and disable actions |

`room.ended` set: show a final screen (`superseded`: opened elsewhere, `kicked`, `full`) and do not rejoin automatically.

## Do not

- Do not call `joinRoom` twice for one room in one tab (the second supersedes the first).
- Do not keep a `Room` after `leave()`.
- Do not read the bus or transport from the UI. If you need something, add a store to the feature.
