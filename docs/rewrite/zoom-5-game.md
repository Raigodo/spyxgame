# Zoom-in 5: game framework (with lobby and chat notes)

Read before touching `game/`, a game's definition, the lobby or chat. It fixes the game framework's API, how a game plugs in, and the host's game loop (task 6 of [plan.md](./plan.md)); lobby and chat get short notes because their shape follows from it. Written after reading `application/game` (2,190 lines), `room-state*`, `client-game-backend`, `lobby/`, `chat/`, both games, the starters and pages, and `docs/invariants.md`; nothing run or typechecked.

## What the game feature is

Answers: which game is running, its replicated state, who may do what in it, and what the host does on its behalf (absence, pause, timers). It replaces `defineGame`'s six generics, `GameRuntime` and `GameHostRuntime`, `AbsenceTimers`, `TimerScheduler`, `ClientGameBackend`, the callback-style `GameHandle`, `RoomStateService` and `room-state.ts` (phase, round, active game, last game), and the per-game channels.

Owns three channels from [zoom-3](./zoom-3-bus.md): `game` (state), `game-events` (event), `game-private` (private). One game runs at a time, so one `game` channel serves every game. Phase is derived: `slot !== null` means playing.

## Data

```ts
type GameState = { round: number; last?: { gameId: string; settings: unknown }; slot: Slot | null };

type Slot = {
  gameId: string;
  version: number;
  seed: number; // seed from the Entropy port, once per round
  settings: unknown;
  state: unknown; // the game's own, validated by its schemas
  setup: {
    mode: LobbyMode;
    teamIds?: string[];
    teams: Record<PlayerId, string>;
    participants: PlayerId[];
    spectators: PlayerId[];
    names: Record<PlayerId, string>;
  };
  x: Record<string, unknown>; // slot features by key (below)
};
```

- `round` increments when a game ends (the lobby derives `ready = readyRound === round`), and `last` lets the lobby offer the game again.
- `participants`, `spectators` and `names` start frozen from the lobby and roster at `start`, then change only by `observe` (late joiners, dropped players, renamed players).
- A new host, a refreshed tab and a late joiner all start from this value; nothing the host knows is missing from it except private pieces, which `recover` rebuilds.

### Slot features (`slot/`, one module per capability)

```ts
interface SlotFeature<X> {
  key: string; // slot.x[key]
  initial(setup: Slot["setup"]): X;
  parse(raw: unknown, env: ParseEnv): X | undefined; // network input; a missing key (older host) returns the default, a malformed one undefined
  effect?: {
    types: readonly string[];
    apply(x: X, e: RawEffect, env: EffectEnv): Result<X, "invalid-effect">;
  };
  observe?(x: X, slot: Slot, obs: Observation, env: ObserveEnv): X; // pure; the host's sync step
}
```

| Feature    | `x[key]` holds                                                                             | Effects it owns                                 | `observe` does                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence` | `away`, `since` (when each missing participant was first seen missing), `paused`, `forced` | none                                            | stamps `since`, marks away after `awayAfterMs`, handles returns and drops by the game's `rejoin` rule, runs the game's `onChange`, then the quorum rule (pause or end) |
| `timers`   | running timers (`deadlineAt`, `frozenMs`)                                                  | `startTimer`, `cancelTimer`                     | freezes timers while paused, restarts them on resume                                                                                                                   |
| `notices`  | newest 50 notices, `seq`                                                                   | `emit`                                          | none                                                                                                                                                                   |
| `private`  | `rev` per player, `seq`                                                                    | none (the game returns pieces beside its state) | rebuilds lost pieces through the game's `recover`                                                                                                                      |

`slot/index.ts` is the ordered list `[presence, timers, notices, private]`; `observe` runs in that order (timers read `paused`). A new capability is one module plus one line in that list; no signature changes. The end of a game is not a feature: see below.

## Public API for game authors

```ts
type GameTypes = {
  settings: unknown; state: unknown
  command: { type: string }                  // a union discriminated by `type`
  event: { type: string }                    // union by `type`: notices and ephemeral events
  reject: string                             // reasons the game's reducers return
  private?: unknown; mode?: LobbyMode        // mode narrows `setup`; default both
}

defineGame<T extends GameTypes>({
  id, version?, migrate?: { state?, settings? },
  modes: readonly LobbyMode[], players?: { min?, max? },
  settings: Schema<T["settings"]>, state: Schema<T["state"]>,
  init({ settings, setup }): T["state"],
  commands: { [K in T["command"]["type"]]: { who?: "participant" | "host" | "anyone"; schema; reduce(a, command) } },   // a new command does not compile without a handler
  events?: { [K in T["event"]["type"]]: { schema } },
  timers?: { [name]: { schema?; reduce(a, payload) } },
  late?(a): LateDecision<T> | undefined,
  presence?: { awayAfterMs?, rejoin?, minPresent?, belowMin?, onChange? },
  private?: { schema, initial?, recover? },
}): GameDef<T>

// reduce args: { state, settings, setup, away, sender: { playerId, peerId }, seed, private: PrivateView<T["private"]> }
type Outcome<T> = Result<{ state: T["state"]; effects?: Effect<T>[]; private?: Record<PlayerId, T["private"] | null> }, T["reject"]>
type Effect<T> = { type: "startTimer"; id: string; timer: string; afterMs: number; payload?: unknown } | { type: "cancelTimer"; id: string }
               | { type: "emit"; event: T["event"] } | { type: "end" }
```

Renames from today, all mechanical: `config` to `settings`, `context` to `setup`, every `validateX` to a kernel `Schema`, `onLateJoin` to `late`, `privateState` to `private`, `allow` to `who`. Game logic still never reads a clock: reducers get no `now`; `startTimer` deadlines are stamped by the framework, and `seed` replaces client-supplied seeds.

`defineGame` returns a `GameDef<T>` carrying a non-generic `runtime` (pure functions: `start`, `play`, `observe`, `fire`, parsers) that only the framework sees, so games of different types sit in one array, as `RegisteredGame` does today.

## Commands on the `game` channel

| Command                                   | Who    | Does                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start { gameId, settings, setup, seed }` | host   | rejects `already-playing`, `unknown-game`, `unsupported-mode`, `too-few-players`, `too-many-players`, `invalid-settings` (also for `settings` over `maxSettingsChars`, since `last.settings` is replicated); else builds the slot (`init`, every feature's `initial`, the game's initial private pieces as `privateWrites`) |
| `play { gameId, command }`                | anyone | the one path for every game command; see the gate below                                                                                                                                                                                                                                                                     |
| `observe { players, removed }`            | host   | `players`: `{ id, name, here }` from the roster; `removed`: playerIds removed on purpose. Records names, decides late joiners, runs every feature's `observe`. Returns the same state when nothing changed                                                                                                                  |
| `fire { id }`                             | host   | runs the handler of a timer that is due on the host clock and removes it in the same commit; a timer not yet due or frozen is a no-op                                                                                                                                                                                       |
| `continue {}`                             | host   | resumes a game paused for lack of players (`forced`)                                                                                                                                                                                                                                                                        |
| `end {}`                                  | host   | slot to `null`, `round + 1`, `last` set                                                                                                                                                                                                                                                                                     |

- **The play gate** is one pure `authorize` in `rules.ts` (a table to test), in this order: no slot, `no-active-game`; `gameId` differs from the slot's, `wrong-game` (a stale page of the last game); unknown command, `unknown-command`; paused and `who !== "host"`, `paused`; `who: "host"` and not from the host, `host-only`; `who: "participant"` and not in `participants`, `not-a-participant`. It replaces the wrapper installed around every handler and the reserved `presence/` prefix, which disappears because commands live inside `play`.
- **The slot schema dispatches by game id.** The channel schema is a kernel `s.custom`: it parses the core with `s.object`, then asks the registry for the game's `settings` and `state` schemas, migrating older versions first. A slot from a newer build is rejected, as today. **An unknown game id does not poison the channel:** the slot is kept opaque (its `settings` and `state` unvalidated), `active.supported` is false, and `play` rejects `unknown-game`. Today an old tab simply never knew that game; here the channel also carries `round` and `last`, which must keep syncing.
- **End is immediate.** An `end` effect, `belowMin: "end"` and the host's `end` all go through one `finish(state)`: the slot is cleared in the same commit. There is no `endRequested` flag and no second hop through the host.
- **Private pieces ride the commit** (`privateWrites`), as in zoom-3. `PrivateDef.revisions` reads `{ round, rev }` from the `private` feature.

## The host's loop (replaces `reconcile`)

`host-flow.ts` is one watcher over `derived([role, bus.sync, value, players, nextWake])`. While this peer is host and `sync` is `ready`:

1. If a slot exists, `apply(observe { players, removed })`.
2. For every timer due on the host clock, `apply(fire { id })`.
3. Arm one wake-up (`Clock.after`) at the earliest of: the next away boundary (`since + awayAfterMs`), the next unfrozen timer deadline. `nextWakeAt` is a pure function in `rules.ts`; the timer is only a wake-up, because the truth is in the slot.

There is no pass loop: a commit changes `value`, the watcher runs again, and each command returns the same state when it has nothing to do, so the loop ends by itself. A guard stays as a safety net: more than `maxSettlePasses` runs caused by the watcher's own commits log a warning and stop until an input changes. An `apply` that answers `"not-ready"` re-runs on `bus.sync` becoming `ready`, like the roster watcher.

- **Away comes from replicated stamps, not roster timing.** `observe` records `since` (bus host time) the first time it sees a participant not `here`, clears it when they return, and marks them away once `awayAfterMs` has passed. This keeps today's 10 s debounce exactly, independent of the roster's 4 s ghost grace (a ghost deleted by the roster is simply still not `here`). `AbsenceTimers` and the host-local `expired` set are deleted; `since` is replicated, so a new host continues the same count.
- **Removed on purpose** comes from roster `left` events with reason `removed` (kick, ban); an entry that expired after its grace is only away. The host keeps the pending ids until an `observe` has applied them (an `apply` that answers `"not-ready"` does not lose them). A removal that happens during a failover falls back to away, as today.
- **The room wires the inputs** (`room/join.ts`): `players` is derived from `roster.players` (`here` is `presence !== "reconnecting"`), `removed` from `roster.events.left`, and the start `setup` from roster plus lobby. Game imports neither feature.

## Client side

```ts
interface GameApi {
  // Room.game
  state: {
    active: Store<{ gameId: string; round: number; supported: boolean } | undefined>;
    last: Store<{ gameId: string; settings: unknown } | undefined>;
    round: Store<number | undefined>;
  };
  actions: {
    start<T>(def: GameDef<T>, settings: T["settings"]): Promise<Result<void, StartReject>>; // host
    end(): Promise<Result<void, "not-host" | "not-playing" | "not-ready">>; // host
    handle<T>(def: GameDef<T>): GameHandle<T>;
  };
}

interface GameHandle<T extends GameTypes> {
  // the same object for the same def
  view: Store<GameView<T> | undefined>; // undefined unless this game is the active one and synced
  send(c: T["command"]): Promise<Result<void, T["reject"] | PlayError | BusFailure>>;
  events: Listenable<{ event: T["event"]; from: PeerId }>; // ephemeral, from `game-events`
  noticed: Listenable<T["event"]>; // each notice once, from state, on every peer
  broadcast(e: T["event"]): boolean;
  sendTo(id: PlayerId, e: T["event"]): boolean;
  continueAnyway(): Promise<Result<void, "not-host" | "not-paused" | "not-ready">>;
  local<L>(def: LocalStateDef<L>): { value: Store<L>; set(next: L): void }; // device-only, per round and player
}

type GameView<T> = {
  // one atomic snapshot, stable reference until a part changes
  round: number;
  settings: T["settings"];
  state: T["state"];
  setup: { mode; teamIds?; teams }; // narrowed by T["mode"]
  me: { playerId: PlayerId; role: "player" | "spectator"; team?: string; private?: T["private"] };
  players: readonly { id: PlayerId; name: string; role: "player" | "spectator"; away: boolean }[];
  away: readonly PlayerId[];
  paused: boolean;
  notices: readonly T["event"][];
  timers: readonly GameTimer[];
};
```

- `view` is `derived([game.value, private.mine])`; `me` uses the constant local `playerId`. The 14 getters and 8 `on…` callbacks of today's `GameHandle`, `GameBackend`, `ClientGameBackend` and its emitters disappear. `noticed` replaces `onNotice` and its `last` bookkeeping (it diffs notice `seq`, never replays on subscribe).
- Host actions use `apply` (synchronous, no queue): a guest gets `not-host`, a host in recovery gets `not-ready`, and the UI disables the buttons while `sync` is not `ready`. `send` for `who: "host"` game commands works for the host through the ordinary queue.
- Local state keeps `game-local:` keys but moves to `Storages.device` with `ttlMs` (ms, per zoom-1).

## Games and the registry (`games/`)

```ts
type GameModule<T extends GameTypes> = {
  def: GameDef<T>;
  label: string;
  Starter: Component<StarterProps<T>>;
  Page: Component;
};
type StarterProps<T> = {
  initial: T["settings"] | undefined;
  disabled: boolean;
  start(settings: T["settings"]): Promise<Result<void, StartReject>>;
};
```

- `games/index.ts` is the single registry, an array of `GameModule`s (erased in the array's type, like `RegisteredGame`). It replaces `games.ts`, `lobby-games.ts` and `game-registry.ts`.
- A game is one folder: `definition.ts`, `rules.ts`, `schemas.ts`, `view.ts`, `Starter.tsx`, `Page.tsx`. The definition and rules import only the game feature's types and the kernel (no React); `Starter` and `Page` use `useGame(def)` and `useStore` from ui.
- **One dynamic route replaces the per-game route file:** `app/room/[roomId]/[game]/page.tsx` renders the module whose `def.id` matches. Adding a game is a folder plus one registry line. `RoomNavigator` follows `room.game.state.active` (`/room/x/<gameId>`, or the lobby; an unsupported game shows a banner and stays). The route is the game id, so `demo-tap` moves from `/demo-game`.
- `Starter` receives `initial` already parsed against the game's `settings` schema (today each starter parses an unknown `initialConfig`) and a typed `start`, so it no longer needs `useRoom()`. The lobby lists modules whose `modes` include the current mode.

## Lobby (short note; its own zoom-in is not planned unless asked)

- Channel `lobby`, owner lobby: `{ setup: { mode: "free-for-all" } | { mode: "teams"; teamIds }, entries: Record<PlayerId, { readyRound?: number; team?: string }> }`. Commands: `setSetup` (host), `setReady { ready, round }` (anyone, own entry; the client supplies `round` from `game.state.round` because a reducer cannot read another channel), `setTeam { team | null }` (own entry, checked against `setup.teamIds`), `observe { here }` (host: stamps `leftAt` on entries of players not in the roster and clears it for returning ones, deletes entries gone longer than `lobbyKeepMs`, evicts the oldest-gone beyond `maxEntries`; replaces the capped `presence:history`, so a player back within `lobbyKeepMs` keeps ready and team, and the map can never outgrow its schema cap).
- Dropped: the `phase !== "lobby"` check on a setup switch (the slot froze its own setup at `start`), the stale-lobby comparison, and `start` as a lobby action. The plan's lobby row loses `phase` and `start`, and gains `canStart`.
- Derived: `ready = entry.readyRound === round`; `LobbyPlayer` is `derived([roster.players, lobby.value, game.round])`; `canStart` is the existing all-ready rule, a UI gate only, as today. The host's `start` action reads the start setup from an injected store and calls `apply`, so the setup is never stale.
- The nickname moved to roster; ready and team keep working across a refresh because they key on `playerId`.

## Chat (short note)

- Channel `chat` (event). History stays local, capped, lost on refresh, absent for late joiners (unchanged).
- Direct messages target `PlayerId`. Sender names and peers are resolved through injected stores built from `roster.players`; sending to a ghost returns `fail("unreachable")`.
- `send(text, to?)` returns a `Result<void, "invalid" | "not-ready" | "rate-limited" | "unreachable">` synchronously: it only talks to the local bus. The plan's rule for intents is therefore "`Result`, wrapped in a `Promise` when the call waits for the host".
- The rate limiter stays (pure, token bucket per sender); readiness is `bus.sync === "ready"` as a store. Config `burst`, `refillPerSecond`, `maxTextLength`, `maxHistory` moves to `chat/config.ts`. The bus's local delivery of own broadcasts replaces the "own line added on receive" special case.

## Inside

```
game/
  index.ts  model.ts (GameTypes, Slot, GameState, GameView, rejects)  config.ts  names.ts
  define.ts          defineGame, GameDef, runtime construction (was game-definition + game-runtime)
  rules.ts           authorize, start check, late join, nextWakeAt, finish
  state.ts           channel def: dispatching slot schema, the six commands
  slot/              presence.ts  timers.ts  notices.ts  private.ts  index.ts (the ordered list)
  host-flow.ts       the watcher and the wake-up
  handle.ts          GameHandle: view, send, events, noticed, local
  local-state.ts     defineLocalState, device storage
games/
  index.ts           the registry
  demo-tap/  spy/    definition, rules, schemas, view, Starter, Page
```

**Moves unchanged:** `computePresence`, `applyQuorum` (into `slot/presence.ts`), timer parse, freeze and unfreeze, `applyPrivate` and revision parsing, `applyEffects` logic, version and migrate, the rate limiter, spy's rules and tests.

`useGame` and `GameShell` live in the ui layer, because `GameShell` combines game and chat; a feature's own `ui/` folder imports only that feature and the ui kit.

**Deleted:** `GameHostRuntime`, `AbsenceTimers`, `TimerScheduler`, `ClientGameBackend`, `GameBackend`, `NOT_JOINED`, the reserved-prefix check, `MAX_PASSES` passes, `endRequested`, `RoomStateService`, `room-state.ts`, `sanitizeGameContext`, `LobbyContext` sanitizing in two places, `games.ts`, `lobby-games.ts`, `game-registry.ts`, the per-game route files.

## Kernel and neighbouring docs touched

- Kernel schema gains `s.nullable(inner)` and `s.custom(fn)` (a check function returning a `Result` with a path), needed by the slot schema ([zoom-1](./zoom-1-kernel.md)).
- Bus `CmdCtx` gains `fromHost: boolean`, which the `play` gate needs ([zoom-3](./zoom-3-bus.md)).
- Roster `left` carries a reason (`"expired" | "removed"`) ([zoom-4](./zoom-4-roster-client.md)).
- Bus gains `now()` (continuous host time) and rejects commands whose result breaks the schema or wire cap ([zoom-3](./zoom-3-bus.md)); `observe`, `fire` and the roster use both.
- Repo `invariants.md` at implementation time: the effects bullet (no `endRequested`) and the presence bullet (written by commands, no `onChange` publish).

## Behavior changes (decision 10 of the plan asks for these to be named)

1. Away is judged from replicated `since` stamps on the bus's continuous host time, not host-local timers, so it survives a failover without skew; the debounce itself (10 s) is unchanged.
2. An `end` effect, `belowMin: "end"` and the host's end clear the slot in the same commit; clients never see a final state with a pending end flag.
3. An unknown game id no longer rejects the channel; the room reports it as unsupported.
4. A command for a game that is not the active one is rejected `wrong-game`.
5. Per-round randomness comes from the `Entropy` port at `start` (`seed` in reduce args); spy's `begin` stops taking a client-supplied seed (task 6c).
6. `fire` ignores a wake-up that is early on the host's clock.
7. No stale-lobby check and no lobby phase check (see the lobby note).

## Guarantees

1. Every change to a running game is a reducer command; the host's own changes (`observe`, `fire`, `end`) are host-only and idempotent. A new host continues from the replicated slot.
2. Game commands are validated twice, as network input (the game's schema) and by the play gate; the sender is the host-verified `playerId`.
3. A timer is removed in the same commit that applies its handler, exactly once; game logic never reads a clock.
4. A private piece goes only to its owner, is committed before the slot that references it, and is shown only if round and revision match.
5. A slot from a newer build is rejected, a missing field from an older build defaults, a malformed one rejects; an unknown game id is kept opaque.
6. While paused, only host commands run and timers are frozen.
7. Every replicated collection has an eviction rule in its reducer (roster entries by `maxPlayers`, lobby entries by `observe`, notices and timers by their caps, `last.settings` by `maxSettingsChars`), and the bus rejects any commit that would break a cap.

## Decisions made here

1. Game commands travel inside one `play { gameId, command }`; the slot schema dispatches by game id; the game feature owns three channels.
2. Capabilities are slot features (`key`, `initial`, `parse`, `effect`, `observe`) in an ordered list; host logic is pure `observe` and `fire` reducers driven by a reactive watcher, with no reconcile passes.
3. Away from replicated `since` stamps; end immediate.
4. `GameTypes` bundle with discriminated command and event unions; schemas replace hand validators.
5. `GameHandle.view` is one atomic store; `GameApi` is `{ state, actions }`.
6. `games/` is one registry with a dynamic route; the route is the game id; `Starter` gets parsed `initial` and a typed `start`.
7. Ready and team stay in lobby with a payload-supplied `round`; chat targets `PlayerId`.

## Not decided here

- The exact `Setup`, `ParseEnv`, `EffectEnv`, `ObserveEnv` field lists (they fall out of porting `slot/*`).
- How `GameShell` and `useGame` look in ui (task 7).
- Whether spy's `word` and `spyId` become private pieces (known-issues lists it as optional; the framework supports it either way).
- The `canStart` rule details and the values of `lobbyKeepMs` and `maxEntries` when the lobby is ported.

## Size and split

**6a** core: `GameTypes`, `defineGame`, `start`, `play`, `end`, the dispatching schema, `GameHandle`, the registry, demo-tap ported (its definition, rules and page). **6b** slot features and the host loop: `presence`, `timers`, `notices`, `private`, `observe`, `fire`, `continue`, the watcher. **6c** spy ported (schemas replace `spy-validation`, `begin` loses its seed).

## Done when

- demo-tap runs from two tabs: start, taps, a late joiner (free-for-all) and a spectator (teams), end returns everyone to the lobby with ready reset.
- Refreshing a player marks it away after `awayAfterMs` and back on return; killing the host mid-game keeps the slot, away set and a running timer correct on the new host.
- A game below `minPresent` pauses (timers frozen) and `continue` resumes it.
- An old tab given a slot of an unknown game keeps syncing and shows "unsupported".
- `game/index.ts` exports only the API above; nothing outside `game/` imports `slot/`, `host-flow` or `state`; games import only the kernel and the game feature's `index.ts`.
- Next: task 7 (ui) is small enough to plan inline; the next zoom-in is whichever task the walking skeleton needs first (tasks 0 to 4c), or ask for a lobby zoom-in.
