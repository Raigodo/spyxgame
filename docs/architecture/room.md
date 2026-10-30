# Room

Read to learn what the UI sees and how a join and a leave are wired. `joinRoom` is the one function the presentation layer calls.

## API

```ts
joinRoom(deps: RoomDeps, params: JoinRoomParams): Promise<Result<JoinedRoom, JoinError>>

interface JoinRoomParams { roomId: RoomId; playerId?: PlayerId; nickname?: string }
interface JoinedRoom { room: Room; generated: boolean }
type JoinError = "unavailable";
```

- `playerId` absent: a new one is minted and `generated` is `true`. The caller stores it (per tab) to rejoin after a refresh.
- `unavailable`: signaling could not be reached. The scope is disposed, nothing is left running.

```ts
interface Room {
  readonly roomId: RoomId;
  readonly playerId: PlayerId;
  readonly self: PeerId;
  readonly role: Store<"guest" | "host">;
  readonly sync: Store<BusSync>; // "lost" | "syncing" | "ready"
  readonly ended: Store<RoomEnd | undefined>; // RoomEnd = { reason: "superseded" | "kicked" | "full" }
  readonly roster: Roster; // see Roster
  readonly game: GameApi;
  leave(): Promise<void>; // idempotent
  debug(): Record<string, unknown>; // snapshot, see Debugging
}
```

`ended` is set once and never cleared; the room has already left when it is set, and the UI shows a final screen. `sync` drives "reconnecting" banners and disabled buttons. Reasons: `superseded` (another tab took this player), `kicked` (kicked or banned), `full`.

## Wiring

`room/join.ts` builds everything on **one root `Scope`**, in this order:

1. `joinTransport(..., scope)` (it registers its own leave on the scope first, so it disposes last). A failure disposes the scope and returns `fail`.
2. `scope.on(transport.dropped, ...)` ends the room with the drop reason (`kicked` or `superseded`).
3. `createBus(..., scope)`.
4. `createRoster(..., scope.child())`, registering its channels. `roster.events.refused` ends the room (`banned` becomes `kicked`, `full` stays `full`).
5. `createGame(..., scope.child())`, with `createGameInputs(roster, scope)` feeding it from the roster (who is here, names, removals), so roster and game never import each other.
6. `bus.start()`, after all channels are registered.

`end(reason)` sets `ended` once, then calls `leave()`. `leave()` runs `scope.dispose()` then `transport.leave()` and is idempotent: a second call returns the same promise. Scope cleanups run in reverse registration order, so game and roster wiring go first, then the bus, then the transport (presence and session).

## RoomDeps

Fields: `clock`, `ids`, `log`, `storages` (`tab`, `profile`, `device`), `entropy`, `games` (`readonly RegisteredGame[]`), `pageLifecycle`, `membership`, `inbox`, `election`, `connections`, `iceServers`, `config` (`RoomConfig`: `signaling`, `link`, `bus`, `roster`, `game`; each layer gets only its own section). Built once by `getRoomDeps()` (via `createRoomDeps()`) in `src/compose.ts` from the real adapters, with `GAME_DEFS` and `DEFAULT_ROOM_CONFIG`. Tests build their own through `RoomHarness` (`room/fakes.ts`).

## What the UI must do

- Call `joinRoom` once per page, keep the `Room`, and call `leave()` on unmount.
- Keep `playerId` in tab storage under `player-id:<roomId>` (`RoomProvider` does it).
- Read only stores and callbacks; call intents; never reach into the bus or transport.

See [Using the room API](../guides/using-the-room-api.md).
