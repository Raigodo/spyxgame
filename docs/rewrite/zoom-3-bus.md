# Zoom-in 3: bus

Read before touching channels, commands, recovery or the wire. It fixes the bus's public API and reshapes how features own replicated data (task 3 of [plan.md](./plan.md)). Written after reading all of `application/messaging` (1,908 lines), its three consumers (room state, game host runtime, chat) and how `multiplayer-client` wires channels today; nothing run or typechecked.

## What the bus is

Answers: how shared state stays replicated, versioned and recoverable across host change. Sole consumer of `Transport` ([zoom-2](./zoom-2-transport.md)). It never looks inside a payload: features give it schemas and reducers.

Kept as-is, behind the new API: `(epoch, rev)` versions, exactly-once commands (`applied` replicated in the same commit), the sender-side `CommandQueue` (TTL 30 s), promotion recovery (`BusRecovery`), self-healing resync, the private-piece algorithm (round and rev matching, commit before publish, owner offers first).

## Decision change: one owner per channel, not one `room` channel

[plan.md](./plan.md) decision 3 proposed merging lobby and game into one `room` channel with sliced reducers. Reading the code shows a cleaner way that needs no compose helper:

- **A channel belongs to exactly one feature** (its schema, commands, config). Cross-feature atomicity is avoided with derived views, not shared channels.
- **Game phase is derived, not stored:** `phase = slot !== null ? "playing" : "lobby"`. "In-game but no slot" and the cross-channel `round` staleness check (what `reconcile` repairs today) cannot exist.
- **Starting a game is one atomic command on the game channel:** `game/start { gameId, settings, context, seed }` creates the slot in its reducer. `context` already carries participants and teams; it gains frozen `names` (today's `namesOf(roster)`), and `seed` comes from the `Entropy` port. `createSlot` is then a pure function.
- **One `game` channel for all games** (not one per registered game), plus one `game-events` and one `game-private`. Only one game runs at a time.
- **Ready is round-scoped as today:** lobby entries hold `readyRound`, and the view derives `ready = readyRound === game.round`, so ending a game resets ready with no cross-channel command.

Proposed channel set (each feature's zoom-in finalizes its own):

| Id              | Kind    | Owner  | Holds                                                       |
| --------------- | ------- | ------ | ----------------------------------------------------------- |
| `roster`        | state   | roster | entries by playerId (name, peer, link, ghost time) and bans |
| `lobby`         | state   | lobby  | setup, per-player `readyRound` and team                     |
| `game`          | state   | game   | `{ round, lastGame?, slot \| null }`                        |
| `game-private`  | private | game   | per-player pieces                                           |
| `game-events`   | event   | game   | game events                                                 |
| `chat`          | event   | chat   | messages                                                    |
| `roster-events` | event   | roster | arbitration ping and pong                                   |

## Public API

```ts
createBus(deps: BusDeps, scope: Scope): Bus       // deps: transport, localPlayerId, clock, ids, log, telemetry, config

interface Bus {
  readonly sync: Store<"lost" | "syncing" | "ready">   // lost: guest with no active host link; syncing: catching up or recovering
  now(): number                                     // continuous host time (guarantee 8); what `ctx.now` is made of
  state<S, C extends Cmd, R extends string>(def: StateDef<S, C, R>): StateHandle<S, C, R>
  events<E>(def: EventDef<E>): EventHandle<E>
  priv<P>(def: PrivateDef<P>): PrivateHandle<P>
  start(): void                                     // channels register before this; registering after throws
}

type Cmd = { type: string }
interface StateDef<S, C extends Cmd, R extends string> {
  id: ChannelId; schema: Schema<S>; init: S
  commands: { [K in C["type"]]: CommandSpec<S, Extract<C, { type: K }>, R> }   // a new command does not compile without a handler
}
interface CommandSpec<S, P, R> {
  who: "anyone" | "host"                            // replaces hostOnly and authorize
  schema: Schema<P>                                 // payload, validated on the host
  reduce(state: S, payload: P, ctx: CmdCtx): Result<{ state: S; privateWrites?: PrivateWrite[] }, R | "invalid" | "too-large">
}
type CmdCtx = { from: PeerId; fromHost: boolean; playerId?: PlayerId; now: number }    // playerId from transport.members, host side; fromHost added by the game zoom-in

interface StateHandle<S, C, R> {
  value: Store<S | undefined>                       // undefined until first synced this session; never the initial value
  synced: Store<boolean>
  send(cmd: C): Promise<Result<void, R | BusFailure>>       // any peer, queued, exactly once, resolves on ack
  apply(cmd: C): Result<void, R | "not-ready">              // host only, synchronous, same reducer, not queued
}
type BusFailure = "expired" | "left"                // TTL passed without ack; client left first

interface EventHandle<E> {
  events: Listenable<{ event: E; from: PeerId }>
  broadcast(e: E): void                             // includes local delivery to the sender, done by the bus
  sendTo(peer: PeerId, e: E): void
}
interface PrivateDef<P> { id: ChannelId; schema: Schema<P>; of: StateHandle<...>; revisions(s): { round: number; rev: Record<PlayerId, number> } }
interface PrivateHandle<P> { mine: Store<P | undefined>; view(playerId: PlayerId): P | undefined }   // view: host side
```

Notes:

- **One mutation path.** `publish` goes away. Host-originated changes (absence, timers, roster names, late join) become `who: "host"` commands whose payload carries the inputs (`present`, `expired`, `names`; `now` comes from `ctx`). On a ready host `apply` runs the reducer synchronously, so `reconcile`'s multi-pass logic still works, and during recovery it returns `"not-ready"` instead of throwing. Every change to replicated state now goes through a reducer; this is also what lets a new host continue from state alone.
- **`privateWrites` is a bus guarantee:** the bus stores them and sends them to owners' links before broadcasting the state that references them, within one commit. Today every game call site repeats `priv.commit(...)` then `publish(...)`.
- **Owner and peer resolution is internal:** the bus reads `transport.members` (playerId per peer, host side) and `links`. That deletes `resolveSender`, `resolveOwner`, `resolvePeer` and `getLocalPlayerId`, which `multiplayer-client` wires by hand today.
- **`ctx.random` is not in the bus.** The per-round `seed` travels in the `game/start` payload.
- `value` is `undefined` rather than `init` so pages cannot mistake an unsynced default for truth; `init` is the host's starting value only.
- A command from a peer with no hello binding gets `unknown-sender` (consumed like any rejection). Intents that must land retry themselves (the roster `join` does).

## Inside (not public)

```
bus/
  index.ts       createBus, types              model.ts   defs, Cmd, CmdCtx, BusFailure, wire schema
  config.ts      names.ts                      rules.ts   compareVersions, isDuplicate, shouldReplaceBest, isRecoveryComplete, status
  channels/      state, event, private         queue.ts   CommandQueue (unchanged)
  recovery.ts    BusRecovery (unchanged)       flow.ts    wire handlers, host and link watchers, resync, flush
  fakes.ts       in-memory transport pair for bus tests
```

- **Reactive instead of manual.** `sync` is `derived([role, host, links, allSynced, recovering], computeStatus)`, so the `refreshStatus()` calls (about ten) and `updateResync` disappear. `flow` watches `transport.host` and `role` for promotion and demotion, and diffs `links` for "peer became active". Because `host` is a store, the `hostMoved`/`lastHostId` dedupe goes. The resync timer starts and stops from a `needsResync` derived store.
- **Wire** uses `s.tagged("kind", ...)`; the typed `wireHandlers` table stays. `__bus` and kind names live in `names.ts`; channel values are checked by the owning def's `schema`.
- **Late channels are gone.** `bootstrapLateChannel` deleted; all channels register before `start()`.
- **`applied` pruning** (review C5): on promote and whenever a member is removed, drop entries for peers no longer in `members`; a departed peer never resends, because peer ids are never reused. Today they are never pruned, so a long room grows by one entry per refresh.
- **Telemetry:** `bus.recovery { ms, offers, adopted }`, `bus.command { result }`, `bus.resync`.

Config keys: `commandTtlMs`, `recoveryWindowMs`, `recoveryMaxMs` (≥ window), `recoveryLinkGraceMs` (< max), `resyncIntervalMs`. `commandTtlMs` must exceed the failover budget, so its relation lives in `compose/relations.ts`.

## Guarantees

1. A command runs exactly once per `(sender, seq)` across host changes; accepted or rejected, it is marked applied.
2. A guest accepts state only if it is newer and from the current host; a new host starts a new epoch.
3. A newly promoted host publishes nothing until recovery ends, holds commands meanwhile and then runs them.
4. `send` resolves once: ack verdict, `expired`, or `left` on dispose.
5. Owners offer their private piece before their state offer; private writes precede the state that references them.
6. Inbound data is parsed once (wire, then channel schema); invalid input is dropped with a throttled `{from, kind}` warning.
   A reducer that returns the same state reference is a no-op: no rev bump, no broadcast (the command is still marked applied). This keeps idempotent host commands such as the roster `sync` from causing commit storms.
7. Transport sends are best-effort, so the bus repeats what must arrive (snapshots every `resyncIntervalMs` while unsynced, commands on link-up and host change).
8. **Host time is continuous across failover.** Every commit carries the host's time (`asOf`); a promoted host sets `offset = asOf - localNow` before its first commit, so `ctx.now` and `bus.now()` carry on from the old host's last time instead of jumping by the clock skew between two machines (the few seconds of the failover are simply not counted). Deadlines and grace periods stored in replicated state use this time and are never compared with a raw local clock.
9. **A commit cannot make state unsyncable.** After every reducer run the host checks the new state against the channel schema and the wire size cap; if either fails, the command is rejected (`invalid` or `too-large`) and state is unchanged. Without this, one state that grew past a cap would be dropped by every guest and could not even be sent by the host. Each collection in a schema still needs its own eviction rule in its reducer.

## Decisions made here

1. One owner per channel; phase derived from slot; one `game` channel for all games (replaces the merged `room` channel).
2. Commands are the only mutation path; `publish` becomes host-only `apply`.
3. `privateWrites` ride the commit; owner and peer resolution is internal.
4. `value` is `undefined` until synced; `sync` is `lost | syncing | ready`.
5. Channels register before `start()` only.
6. Continuous host time (`bus.now()`) and host-side validation of reducer output.

## Not decided here

- Resolved in [zoom-5](./zoom-5-game.md): the pause gate is one pure `authorize` inside a single `play` command, the slot schema dispatches by game id (`s.custom`), and reconcile becomes a reactive watcher over idempotent `apply` commands.
- Resolved in [zoom-4](./zoom-4-roster-client.md): `roster` holds entries and bans; `roster-events` is ping and pong only.
- Which peer gets a private piece when two live peers share a `playerId` (roster arbitration normally removes one first).
- Whole-state broadcast per commit stays; patches only if big boards need them.

## Done when

- `index.ts` exports only the API above; no feature imports `channels/` or `flow`.
- A counter state channel plus an event channel and a private piece survive a host change on fakes: no command lost or applied twice, guests converge.
- `bus-rules`, `wire`, `command-queue`, `bus-recovery` tests carry over.
- Next: zoom-in 4, roster and room (written).
