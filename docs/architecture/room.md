# Room

Read to learn what the UI sees and how a join and a leave are wired. `joinRoom` is the one function the presentation layer calls.

## API

```ts
joinRoom(deps: RoomDeps, { roomId, playerId?, nickname? }):
  Promise<Result<{ room: Room; generated: boolean }, "unavailable">>
```

- `playerId` absent: a new one is minted and `generated` is `true`. The caller stores it (per tab) to rejoin after a refresh.
- `unavailable`: Firestore or signaling could not be reached. Nothing is left running.

```ts
interface Room {
  roomId: RoomId;
  playerId: PlayerId;
  self: PeerId;
  role: Store<"guest" | "host">;
  sync: Store<"lost" | "syncing" | "ready">;
  ended: Store<EndReason | undefined>; // "superseded" | "kicked" | "full"
  roster: Roster; // see Roster
  game: GameApi; // state, actions (start, end), per-game handles
  leave(): Promise<void>; // idempotent
  debug(): DebugSnapshot; // see Debugging
}
```

`ended` is set once and never cleared: the room is over for this tab and the UI shows a final screen. `sync` drives "reconnecting" banners and disabled buttons.

## Wiring

`room/join.ts` builds everything on **one root `Scope`**:

1. `joinTransport` (registers its leave on the scope).
2. `createBus`.
3. Roster and game on **child scopes**, each registering its channels.
4. `createGameInputs` feeds the game from the roster (who plays, names, removals), so the two never import each other.
5. `bus.start()`.
6. Subscriptions turn `transport.dropped`, `roster refused` and `superseded` into `ended`.

Because scopes dispose last-registered-first, `leave()` tears down client wiring, then the bus, then presence and the session. `leave()` is idempotent; a second call returns the same promise.

## RoomDeps

Built once by `getRoomDeps()` in `src/compose.ts`: clock, ids, logger, storages, Firestore ports, RTC provider, ICE source, entropy, the game list (`GAME_DEFS`) and config overrides. Tests build their own through `RoomHarness`.

## What the UI must do

- Call `joinRoom` once per page, keep the `Room`, and call `leave()` on unmount.
- Keep `playerId` in tab storage under `player-id:<roomId>`.
- Read only stores and callbacks; call intents; never reach into the bus or transport.

See [Using the room API](../guides/using-the-room-api.md).
