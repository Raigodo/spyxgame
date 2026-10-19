# High-level plan

Read first when planning any piece of the rewrite. It fixes the project shape only: layers, their public APIs, the types each layer owns, and the decisions that steer later zoom-ins. Internals are left to the zoom-in docs listed at the end. Builds on [proposal.md](./proposal.md) and revises it where noted. Status: plan, nothing applied.

## Shape in one picture

```
ui          React: RoomProvider, useStore, useGame, GameShell, slice ui/ folders
  |
room        joinRoom -> Room: one join, one Scope, one object for the UI
  |
features    roster | lobby | chat | game                    (peers: never import each other)
  |
bus         replicated channels: state, event, private     (the only user of transport)
  |
transport   star network: peers, host, verified sender     (signaling + link + relay inside)
  |
kernel      Store, Emitter, Scope, Result, schema, config, ports, branded ids
```

`games/` (spy, demo-tap) sits beside `features/` and plugs into `game`. `compose.ts` is the only file that picks real adapters and defaults. A layer imports only from layers below it. Peer features never import each other: cross-feature reads arrive as injected `Store`s wired per join in `room/join.ts` (`compose.ts` only picks adapters and defaults). A feature's `ui/` folder belongs to the ui layer: it imports only its own feature and the ui kit; `GameShell` and `useGame`, which combine features, live in the ui layer.

## Rules every public API follows

- **State is a `Store<T>`** (`get`, `subscribe`, stable reference until a real change). **Moments are `Emitter<E>`** (kicked, superseded, notice, chat message).
- **Intents return `Result<T, Reason>`, wrapped in a `Promise` when the call waits for the host, and never throw** for expected failures (chat `send` is local, so it returns a plain `Result`). `Reason` is a typed string union owned by the layer that rejects.
- **Shape per feature: `{ state, actions, events }`.**
- **Construction is `createX(deps, config)`** with required deps and no defaults. Teardown is `scope.dispose()`, which runs in reverse construction order.
- **Names and numbers** live in the owning layer's `config.ts` and `names.ts`. Nothing else holds a literal.

## Layers: API and owned types

### kernel

Owns (full API: [zoom-1-kernel.md](./zoom-1-kernel.md)): `Store<T>` (read side) with `Cell<T>` (owner side), `derived`, `batch`, `Listenable<E>` with `Emitter<E>`, `Scope`, `Result<T, R>`, `s.*` schema helper, `defineConfig`, ports (`Clock`, `Ids`, `Log`, `KeyValueStore`, `PageLifecycle`, `Telemetry`), and branded ids `PlayerId`, `PeerId`, `RoomId`, `ChannelId`. No slice knowledge, no per-feature config sections.

### transport

Answers: who is connected, who is host, and what did a verified peer send. Knows peers and one durable `PlayerId` per peer. Does not know names, lobby, bus or games.

```ts
joinTransport(deps, { roomId, playerId }, scope): Promise<Result<Transport, JoinError>>   // scope disposal = leave

interface Transport {
  self: PeerId
  role: Store<"guest" | "host">
  host: Store<PeerId | undefined>
  members: Store<ReadonlyMap<PeerId, Member>>    // membership; playerId known on the host only
  links: Store<ReadonlyMap<PeerId, LinkState>>   // host: every guest; guest: the host
  send(to: PeerId, msg: Wire): void              // may be dropped, callers repeat what must arrive
  broadcast(msg: Wire): void                     // any role, relayed by the host, no echo
  messages: Listenable<{ from: PeerId; msg: Wire }>
  drop(peer: PeerId, reason: DropReason): Promise<void>   // host only: kick, superseded; sends a `bye` first
  dropped: Listenable<DropReason>                // this peer was dropped by the host
  handOff(to: PeerId): Promise<Result<void, HandOffReject>>
  leave(): Promise<void>
}
```

Inside: signaling, link, relay, claim, election, reclaim. Public API does not expose them. Full contract: [zoom-2-transport.md](./zoom-2-transport.md).

### bus

Answers: how shared state stays replicated and versioned across host change. Sole consumer of `Transport`.

```ts
createBus(deps, scope): Bus

interface Bus {
  sync: Store<"lost" | "syncing" | "ready">
  now(): number                                   // continuous host time
  state<S, C, R>(def: StateDef<S, C, R>): { value: Store<S | undefined>; synced: Store<boolean>; send(c: C): Promise<Result<void, R | BusFailure>>; apply(c: C): Result<void, R | "not-ready"> }
  events<E>(def: EventDef<E>): { events: Listenable<{ event: E; from: PeerId }>; broadcast(e: E): void; sendTo(p: PeerId, e: E): void }
  priv<P>(def: PrivateDef<P>): { mine: Store<P | undefined>; view(id: PlayerId): P | undefined }
  start(): void
}
// StateDef: { id, schema, init, commands: { [type]: { who: "anyone" | "host", schema, reduce(state, payload, ctx) -> Result<{ state, privateWrites? }, R> } } }
// ctx: { from, fromHost, playerId?, now }; a command whose result breaks the schema or wire cap is rejected, never published
```

Full contract: [zoom-3-bus.md](./zoom-3-bus.md).

Channels are declared at composition, before join. Epoch/rev, exactly-once commands and promotion recovery stay as today, behind this API.

### features (peers)

| Feature | Owns                                                                                                                                          | `state`                         | `actions`                                   | `events`                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| roster  | who is here and who may not be: `Player { id, name, presence, isHost, joinedAt }`, one replicated channel keyed by `playerId`, bans inside it | `players`, `me`, `host`, `bans` | `rename`, `handOff`, `kick`, `ban`, `unban` | `joined`, `rejoined`, `left`                     |
| lobby   | `LobbySetup { mode, teamIds }`, per-player `readyRound` and `team`                                                                            | `setup`, `players`, `canStart`  | `setReady`, `setTeam`, `setSetup`           | none                                             |
| chat    | capped history                                                                                                                                | `messages`                      | `send`                                      | `message`                                        |
| game    | the one `game` channel: `round`, `last`, `Slot` (state, setup, slot features); phase is `slot !== null`                                       | `active`, `last`, `round`       | `start`, `end`, `handle(def)`               | none (a `GameHandle` has `events` and `noticed`) |

Each feature keeps the slice anatomy from the proposal (`config`, `names`, `model`, `state`, `rules`, `flow`, `ui/`, `README`). Roster owns identity and presence only. Ready and team belong to lobby, keyed by `playerId` (this revises R2). The derived "participant" a game sees is a projection of roster plus its own channel (lobby and game zoom-ins), not a stored shape.

### game framework and `games/`

```ts
type GameTypes = { settings; state; command; event; reject; private?; mode? }   // one bundle, replaces 6 generics; command and event are unions by `type`

defineGame<T extends GameTypes>({ id, modes, settings: Schema, state: Schema, init, commands: { [type]: { who?, schema, reduce } }, events?, timers?, late?, presence?, private? }): GameDef<T>
type GameModule<T> = { def: GameDef<T>; label: string; Starter: Component<StarterProps<T>>; Page: Component }   // the route is the game id

interface GameHandle<T> {
  view: Store<GameView<T> | undefined>              // atomic: state, settings, me, role, players, away, paused, notices, timers
  send(c: T["command"]): Promise<Result<void, T["reject"] | BusFailure>>
  events: Listenable<{ event: T["event"]; from: PeerId }>   // ephemeral; `noticed` carries state notices
}
```

`games/index.ts` is the single registry. A game is one folder (definition, rules, validation, view, Starter, Page); adding one is a folder plus one registry line (one dynamic route renders every game page). Framework capabilities (away/pause, timers, notices, private pieces) are slot features `{ key, initial, parse, effect?, observe? }` in an ordered list, so a new capability adds a module, not a signature. Game commands travel inside one `play` command; the host's own changes are idempotent `observe`, `fire` and `end` commands driven by a reactive watcher. Full contract: [zoom-5-game.md](./zoom-5-game.md).

### room

One function and one object the UI sees. There is no reusable client: the app creates one per room and never rejoins, so a `Room` exists only once joined and every store on it is real.

```ts
joinRoom(deps, { roomId, playerId?, nickname? }): Promise<Result<{ room: Room; generated: boolean }, JoinError>>

interface Room {
  roomId; playerId; self                           // constants
  role: Store<"guest" | "host">
  sync: Store<"lost" | "syncing" | "ready">
  ended: Store<undefined | { reason: "superseded" | "kicked" | "full" }>
  roster; lobby; chat; game                        // feature APIs
  leave(): Promise<void>                           // idempotent
}
```

One join = one `Scope` that builds transport, bus and all features, and disposing it is leaving. This replaces `performJoin`, `assemble`, `wire` and the subscribe-before-join step. Full contract: [zoom-4-roster-client.md](./zoom-4-roster-client.md).

### ui

`RoomProvider({ games })` (calls `joinRoom`, renders children once a `Room` exists), `useStore(store)`, `useGame(def)` (one atomic snapshot plus `send`), `GameShell` (header, end, leave, chat). Feature UI sits in `features/<name>/ui/`. `app/` holds routes only, with an `error.tsx` under `[roomId]`.

## Decisions that steer later zoom-ins

1. **Transport knows peers, not players.** Only one durable `PlayerId` per peer, host-stamped. Algorithms in "keep unchanged" ([review.md](./review.md)) move inside it untouched.
2. **Bus is the only transport consumer.** Presence, status, hello, chat and game traffic all become channels, so `__bus` and the status/`hello` events disappear.
3. **A channel has exactly one owning feature.** Cross-feature atomicity is avoided with derived views: game phase is `slot !== null`, and starting a game is one atomic command on the single `game` channel. This replaces the merged `room` channel (see [zoom-3-bus.md](./zoom-3-bus.md)). Commands are the only mutation path; host-originated changes are `who: "host"` commands applied synchronously with `apply`.
4. **Data kinds** (proposal table) decide where a fact lives. A fact lives with the feature that owns it, never in a generic bag.
5. **Ghost means "roster entry whose peer left membership" (`goneAt`), expired by the host after a grace period on continuous host time.** `rejoined` is derived from ghost to online. No history channel, no restore, no hello. Duplicate tabs are arbitrated without hide/reveal, and bans live inside the roster state ([zoom-4-roster-client.md](./zoom-4-roster-client.md)).
6. **Host change rebuilds from replicated state.** The host keeps no memory the slot cannot reconstruct (effects and timers stay data in the slot).
7. **Kick, supersede and ban are `transport.drop` plus a roster decision.** The dropped peer learns why from a `bye` frame (`transport.dropped`). No admit hook in transport.
8. **Config and names per layer,** assembled in `compose.ts`, with a generated `docs/config.md` and one `relations.ts` for cross-timer rules.
9. **Failures are typed.** `BusFailure = "expired" | "left"` ([zoom-3-bus.md](./zoom-3-bus.md)), plus a typed reject union per game and per feature.
10. **No behavior change to resilience semantics** during the rewrite. Any change to election, reclaim, ghost or recovery behavior is a separate, named decision.
11. **Host-driven game changes are idempotent host commands** (`observe`, `fire`, `end`) from a reactive watcher; there are no reconcile passes. Away is derived from replicated `since` stamps in the slot, and ending a game clears the slot in the same commit ([zoom-5-game.md](./zoom-5-game.md)).
12. **Host time is continuous across failover, and no commit can make state unsyncable.** The bus carries the host's time in every commit, a promoted host continues from it instead of its own clock, and the host rejects any command whose result breaks a schema or the wire cap. Grace periods, deadlines and `since` stamps in replicated state rely on this ([zoom-3-bus.md](./zoom-3-bus.md)).

## Strategy and task breakdown

Rewriting a lower API breaks everything above it, so build the new tree in `src/` and park the old code in `legacy/` as read-only reference. Port proven files (election, chunking, reclaim, rules, parsers) into the new layers as their seams appear, then delete `legacy/`. Aim for a walking skeleton early: two tabs join, see each other, survive a refresh and a host kill, before any game exists.

| #   | Task                                                                                                                                                                 | Size | Done when                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0   | CI workflow, deploy gate, `error.tsx`, `passWithNoTests`, move old code to `legacy/`                                                                                 | S    | `pnpm check` green on an empty shell                                                                                          |
| 1   | Kernel: Store, derived, Scope, Result, schema, defineConfig, ports, ids                                                                                              | S    | kernel public API frozen                                                                                                      |
| 2a  | Transport: signaling module (move, config, names, members/host stores, in-memory fakes for its ports)                                                                | M    | host election and member removal work on fakes                                                                                |
| 2b  | Transport: link module (move, `links` store, ICE source port)                                                                                                        | M    | two fake peers exchange a chunked message                                                                                     |
| 2c  | Transport: relay, claim, flow, `drop` with `bye`, `joinTransport` facade                                                                                             | M    | two tabs exchange `Wire`; host kill elects a new host; host refresh reclaims; a dropped guest is told and starts no election  |
| 3   | Bus: state/event/private channels, recovery, `sync`, continuous host time, output validation                                                                         | M    | counter channel survives host change; a command that would exceed a cap is rejected and state is unchanged                    |
| 4a  | Roster feature: channel, flows, moderation (kick, ban), capacity, derived `players`, fakes                                                                           | M    | join, refresh, ghost, supersede, kick, ban, a full room work on fakes                                                         |
| 4b  | Room: `joinRoom` builds one `Scope`, `Room` object, join/leave                                                                                                       | M    | joins and leaves repeatedly with nothing leaked                                                                               |
| 4c  | Minimal UI and the walking-skeleton check                                                                                                                            | S    | two tabs join, refresh, survive a host kill                                                                                   |
| 5a  | Chat                                                                                                                                                                 | S    | messages and rate limit work                                                                                                  |
| 5b  | Lobby (setup, ready, team, `canStart`, `observe` pruning; `round` is an injected store, a constant until 6a)                                                         | S    | lobby page works; entries of departed players are pruned and capped                                                           |
| 6a  | Game framework core: `GameTypes`, `defineGame`, `start`/`play`/`end`, dispatching slot schema, `GameHandle`, registry; port demo-tap                                 | M    | demo-tap runs                                                                                                                 |
| 6b  | Slot features (presence, timers, notices, private), `observe`/`fire`/`continue`, host watcher                                                                        | M    | away, pause and resume, timer fire, notice and private-piece recovery scenarios pass on fakes, including across a host change |
| 6c  | Port spy                                                                                                                                                             | M    | spy plays a full round                                                                                                        |
| 7   | UI: `useGame`, `GameShell`, feature `ui/` folders                                                                                                                    | S    | no page reaches below `Room` or a feature API                                                                                 |
| 8   | Tests that remain after the per-task scenarios (open point 8): contract tests against real adapters, property tests (reducers idempotent), the "keep unchanged" list | M    | the list is covered                                                                                                           |

Each row is small enough for its own zoom-in plan and a single working session.

## Zoom-ins to write next (in order)

1. Kernel API (task 1): written, see [zoom-1-kernel.md](./zoom-1-kernel.md).
2. Transport (task 2): written, see [zoom-2-transport.md](./zoom-2-transport.md).
3. Bus (task 3): written, see [zoom-3-bus.md](./zoom-3-bus.md).
4. Roster and room (task 4): written, see [zoom-4-roster-client.md](./zoom-4-roster-client.md).
5. Game framework (task 6): written, see [zoom-5-game.md](./zoom-5-game.md) (lobby and chat notes inside).
6. Next on demand: a lobby zoom-in, or start with tasks 0 to 4c.

## Open points to confirm (defaults in bold)

1. Old code parked in `legacy/` while the new tree grows: **yes**, versus in-place layer-by-layer.
2. One owning feature per channel, phase derived from the game slot, one `game` channel for all games (replaces the merged `room` channel): **yes**.
3. Ready and team owned by lobby, not roster: **yes**.
4. Transport carries `PlayerId` as its one durable identity: **yes**.
5. Five layers above kernel (transport, bus, features, room, ui) instead of the proposal's ten tiers: **yes**.
6. One dynamic route `app/room/[roomId]/[game]` renders every game page, the route being the game id (`demo-tap` moves from `/demo-game`): **yes**, versus a route file per game.
7. Private pieces stay in the framework although no game uses them yet (spy's word and spy could): **yes**, versus deleting them.
8. Scenario tests on the in-memory fakes (the "done when" of tasks 2 to 6) are written with each task, the fake harness being built in 2a, rather than all in task 8: **yes**, versus tests only at the end (resilience code would then be rewritten with no safety net).
9. Defer the `Telemetry` port and the generated `docs/config.md` until something consumes them, and keep config descriptors to one `why` string per knob plus the `destructive` flag: **yes**, versus the full descriptor set in zoom-1.

## Unverified

- Written from reading the code in earlier turns; nothing run or typechecked.
- Decision 5 (ghost as roster entry) depends on the task 4a fakes scenarios (refresh, double refresh, host kill mid-grace).
- The design was reviewed once by me and once by a fresh reader of the docs; findings that were confirmed against the old code are folded in (decisions 5, 11, 12, open points 8 and 9). Nothing was run.
