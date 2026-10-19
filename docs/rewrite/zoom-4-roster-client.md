# Zoom-in 4: roster and room

Read before touching presence, the player list, kick or ban, or the join flow. It fixes the roster feature (moderation included) and replaces `MultiplayerClient` with a `joinRoom` function that returns a `Room` (task 4 of [plan.md](./plan.md)). Written after reading `application/presence`, `application/room`, `lobby/`, `chat/`, the provider and the transport and bus zoom-ins; nothing run or typechecked.

## Roster

Answers: who is in the room, under which name, how reachable they are, and who may not be. It replaces `PlayerSession`'s roster half, `PlayerPresenceService`, `PlayerReconnectionCoordinator`, `PresenceBook`, `DuplicateView`, `DepartureGhosts`, the `presence`, `presence:history` and `presence:bans` channels, and the `metadata` bag.

### Data: one replicated `roster` channel, keyed by `playerId`

```ts
type Entry = { name: string; joinedAt: number; peerId?: PeerId; link: LinkState; goneAt?: number }; // peerId undefined = ghost
type RosterState = { entries: Record<PlayerId, Entry>; bans: PlayerId[] }; // bans: newest `banLimit`
type RosterReject =
  "taken" | "banned" | "full" | "invalid" | "unknown-player" | "cannot-target-self";
```

Bans live in the same state as entries, so `join` can reject a banned player inside a pure reducer, and `ban` removes the entry and records the ban in one commit.

| Command                                     | Who    | Does                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `join { name }`                             | anyone | for `ctx.playerId`: banned → `banned`; no entry and `maxPlayers` entries exist → `full`; entry whose `peerId` is a different peer with an `active` link → `taken`; otherwise create the entry or take it over (`peerId = ctx.from`, `joinedAt` and the stored name kept) |
| `rename { name }`                           | anyone | rename `ctx.playerId`'s own entry                                                                                                                                                                                                                                        |
| `sync { links: Record<PeerId, LinkState> }` | host   | `links` has one key per current member peer (`connecting` until a link is up). An entry whose `peerId` is a key takes that state; an entry whose peer is no longer a member becomes a ghost (`goneAt = ctx.now`); ghosts older than `departureGraceMs` are removed       |
| `remove { playerId }`                       | host   | delete the entry at once (kick)                                                                                                                                                                                                                                          |
| `ban { playerId }` / `unban { playerId }`   | host   | `ban` = delete the entry plus add to `bans`                                                                                                                                                                                                                              |

A reducer that returns the same state is a no-op (no rev bump; see [zoom-3](./zoom-3-bus.md)), so `sync` is safe to apply whenever its inputs change. `peerId` in an entry always comes from `ctx.from`, never from a payload.

**A ghost is an entry whose peer left membership** (the authoritative removal path), never merely one whose hello or link has not arrived. `sync` is keyed by peer, so a promotion or a slow link ghosts nobody, and two members sharing a `playerId` cannot make an entry flap between peers. Times are `ctx.now`, the bus's continuous host time, so a failover does not skew the grace.

Events on `roster-events`: `ping { nonce }` and `pong { nonce }`, nothing else. Status, restore, hello, rejected, duplicate, kicked and farewell all disappear: status and farewell are state, rejection and kick travel as a transport `bye` (below).

### Host flow (`host-flow.ts`, one watcher, decisions in `rules.ts`)

While this peer is host, `scope.watch(derived([members, links, entries, bus.sync, role]))` makes the roster match what the transport sees:

1. **Self.** `apply(join)` for the host's own entry (also for a refreshed host reclaiming its seat).
2. **Sync.** `apply(sync)` with a `links` key for every member peer; plus one timer for the next ghost expiry. The timer is only a wake-up: the truth is `goneAt` in replicated state, so a new host re-derives it.
3. **Duplicates.** A member whose `playerId` has an entry held by another peer with an `active` link is a newcomer rejected as `taken`. If the entry's peer is the host's own tab: `drop(newcomer, "superseded")` at once. Otherwise `ping` the entry's peer: a `pong` within `pingTimeoutMs` means alive, so `drop(newcomer, "superseded")`; silence means `drop(old, "superseded")`, the next `sync` ghosts the entry and the newcomer's retry succeeds. After a promotion it waits for links to be `active` (cap `linkWaitMs`) before pinging. A peer taken over while its link was only `reconnecting` stays a member without an entry; when it returns, its `join` is `taken` and the same arbitration runs against the newer tab.
4. **Bans.** A member whose `playerId` is in `bans` gets `drop(peer, "kicked")` (covers a client that ignores its own rejection).

If `apply` returns `"not-ready"` (recovery), the watcher re-runs when `bus.sync` becomes `ready`, since it is an input.

### Guest flow (`guest-flow.ts`)

- **Join, self-healing.** On link-up and on host change, send `join { name }` until the synced roster holds my entry with my `peerId`; repeat every `joinRetryMs`, with at most one `join` pending in the bus queue (a retry never queues behind itself while the host is unreachable). `taken` keeps retrying (arbitration decides); `banned` ends the room as `kicked`; `full` ends it as `full`.
- **Pong.** Answer a host `ping`.
- A newcomer is simply absent from `players` until admitted. There is no hide or reveal, no pending lock: `me` is `undefined` until admitted. Ready and team belong to lobby under the same `playerId`, so they survive a refresh.

### Moderation (`moderation.ts`, inside roster)

`kick(id)` = `apply(remove)` then `transport.drop(peer, "kicked")`. `ban(id)` = `apply(ban)` then the same drop. `unban(id)` = `apply(unban)`. Moderation sits in roster because bans gate admission and act on entries; a separate feature above roster would be read by roster. The plan has no separate moderation feature.

### Public API

```ts
type Presence = "self" | "online" | "connecting" | "reconnecting";
interface Player {
  id: PlayerId;
  name: string;
  peerId?: PeerId;
  presence: Presence;
  isHost: boolean;
  joinedAt: number;
}
type TargetReject = "not-host" | "not-ready" | "unknown-player" | "cannot-target-self";

interface Roster {
  state: {
    players: Store<readonly Player[]>;
    me: Store<Player | undefined>;
    host: Store<Player | undefined>;
    bans: Store<ReadonlySet<PlayerId>>;
  };
  actions: {
    rename(name: string): Promise<Result<void, "invalid" | BusFailure>>; // saves the nickname to the profile store on success
    kick(id: PlayerId): Promise<Result<void, TargetReject>>; // host only
    ban(id: PlayerId): Promise<Result<void, TargetReject>>;
    unban(id: PlayerId): Promise<Result<void, TargetReject>>;
    handOff(id: PlayerId): Promise<Result<void, TargetReject | HandOffReject>>;
  };
  events: {
    joined: Listenable<Player>;
    rejoined: Listenable<Player>;
    left: Listenable<{ player: Player; reason: "expired" | "removed" }>;
  }; // removed: kick or ban
}
```

- `players` is `derived([entries, transport.links, transport.host, transport.self])`, in `joinedAt` order, ghosts included. `presence` comes from the entry's `link`, except `self` and the host row (a guest overlays its own link to the host, faster than a broadcast). Ghosts are rows with `peerId` undefined and `presence: "reconnecting"`.
- `joined`, `rejoined`, `left` are derived by diffing `players` (new entry, ghost to online, entry removed). `updated` is gone (stores replace it), `superseded` and `kicked` are the room's `ended`.
- Public targets are `PlayerId`, never peer ids (kick, ban, hand off, direct chat).
- A game's "removed on purpose, drop at once" is `left` with reason `removed` (kick or ban); an entry that expired after its grace is only away ([zoom-5](./zoom-5-game.md)).

### Config

`maxPlayers` (room capacity; bounds every per-player map and the whole-state broadcast), `departureGraceMs` (old name kept), `pingTimeoutMs` (destructive: can drop a live peer), `linkWaitMs`, `joinRetryMs`, `maxNameLength`, `banLimit`, `profileTtlMs`. `duplicateRevealTimeoutMs` is deleted with the reveal machinery. Telemetry: `roster.arbitration { outcome }`, `roster.expel { reason }`.

### Behavior changes (decision 10 of the plan asks for these to be named)

1. Ghost rows are replicated and host-driven, not per-peer local timers: identical on every peer and kept across a host change. The grace runs on the bus's continuous host time, so a failover neither skews nor restarts it (a few seconds of the failover itself are not counted). A room now has a capacity (`maxPlayers`), which the old code did not.
2. During arbitration the old row is no longer shown as reconnecting for up to 2 s, and the newcomer is simply absent.
3. Connection status travels in the replicated roster, not a separate `status` event; each link change rebroadcasts the small roster.
4. Arbitration no longer needs to know which tab is older: the entry holder is the older one by construction.
5. The kick and supersede notice is a transport `bye` frame, in order with the removal, not a separate event that races it.

## Transport change (also in [zoom-2](./zoom-2-transport.md))

`Transport` gains `dropped: Listenable<DropReason>`. `drop(peer, reason)` sends `bye { reason }` on that link, removes the member, and closes the link only after the `bye` has drained. A guest that receives `bye` (or whose link closes while it is no longer a member) reports `dropped`, closes the link itself and never suspects the host. Details: [zoom-2](./zoom-2-transport.md) guarantee 7.

## Room (replaces the client)

The app creates a new client per room and never rejoins, so a reusable facade (`session` states, `busy`, forwarded `flatten` stores, "getters safe in any state") buys nothing. A function that returns a `Room` only once joined makes every store real.

```ts
joinRoom(deps: RoomDeps, params: { roomId: RoomId; playerId?: PlayerId; nickname?: string })
  : Promise<Result<{ room: Room; generated: boolean }, JoinError>>      // generated: a new playerId was minted

interface Room {
  readonly roomId: RoomId; readonly playerId: PlayerId; readonly self: PeerId
  readonly role: Store<"guest" | "host">
  readonly sync: Store<"lost" | "syncing" | "ready">
  readonly ended: Store<undefined | { reason: "superseded" | "kicked" | "full" }>
  roster: Roster; lobby: Lobby; chat: Chat; game: GameApi
  leave(): Promise<void>                                // idempotent
  debug(): Record<string, unknown>                      // the old getDebugState, exempt from the store rule
}
```

Join flow, the only one:

1. Mint `playerId` if absent; read the saved nickname for it (`Storages.profile`), falling back to "Player".
2. `scope = new Scope`; `joinTransport(...)`. On failure dispose the scope and return `fail`.
3. `createBus`, then features in tier order (roster, lobby, chat, game), each on `scope.child()`, registering channels.
4. `bus.start()`.
5. `scope.on(transport.dropped, reason => end(reason))`: sets `ended` and leaves. A `banned` rejection ends it the same way.

`leave()` is `scope.dispose()` (features reversed, bus, transport) then `await transport.leave()`. This deletes `performJoin`, `assemble`, `wire`, `teardown`, `ClientLifecycle`, `HostSeatKeeper` (now in transport), the duplicate `remember` call, about 15 `on…` callbacks, `refreshPlayers`, `refreshPending`, `lifecycle.sync()` calls and the subscribe-before-join step (`ended` is a store, so a supersede during join is never missed). Kernel `flatten` has no consumer and is dropped.

Lobby and game projections (a `LobbyPlayer` with ready and team, game participants) are derived stores built from `roster.players` plus their own channel; the lobby and game zoom-ins specify them.

### UI consequences

- `RoomProvider` calls `joinRoom` in its effect (keeping the deferred tick for StrictMode), holds `room` in state and renders children only once it exists, so `useRoom()` returns a `Room`, never `undefined`. "Connecting…" and "Couldn't join" are provider state; "disconnected" and "removed" read `room.ended`.
- Pages stop deriving "me" by searching `players`: `room.playerId` is a constant.
- The TURN fetch leaves the provider (ICE source port in transport deps, [zoom-2](./zoom-2-transport.md)).

## Inside

```
roster/
  index.ts  model.ts (Entry, Player, schemas)  config.ts  names.ts
  rules.ts            reducers' pure parts, duplicate planning, projection of entries to players
  state.ts            channel handles, derived players, bans
  host-flow.ts        self, sync, duplicates, ban enforcement, ghost timer
  guest-flow.ts       join retry, pong
  moderation.ts       kick, ban, unban, handOff
  profile-store.ts    nickname memory (was PlayerProfileStore)
  ui/                 player list, kick and ban buttons, connection badge
room/
  index.ts (joinRoom, Room)  join.ts  config.ts  debug.ts
```

## Guarantees

1. Every roster write is a reducer command; host-originated ones are host-only. A new host continues from the replicated roster.
2. A player appears in `players` only after admission (not banned, duplicate resolved); `peerId` comes from the verified transport view.
3. A refresh is one row going `reconnecting` then `online`, in its old position; an expired ghost is removed by the host.
4. Kick and ban remove the row at once and the target is told through the transport `bye`.
5. A lost `join` or `pong` heals: joins repeat until acknowledged.
6. Ghosting follows membership, never link or hello timing; grace runs on continuous host time; the room never holds more than `maxPlayers` entries.

## Decisions made here

1. Roster is one replicated channel keyed by `playerId`, bans inside it; moderation is part of roster.
2. Anyone sends `join`; the reducer enforces `taken` and `banned`; the host writes only observations (`sync`), removals and bans. (The alternative, a host-only `join` after a separate `join-request` event, needs a second event kind and a pending state for no extra safety.)
3. Duplicate arbitration without hide or reveal: the entry holder is the older tab; a ping decides who is dropped.
4. Ghosts are replicated entries with `goneAt`, expired by the host inside `sync`.
5. No `restore`, `history`, `hello` or pending lock.
6. Public targets are `PlayerId`; `Player` carries `joinedAt` and `presence`.
7. `joinRoom` returning a `Room` replaces the client class; `ended` and `sync` are stores.
8. Transport `dropped` plus the `bye` frame carry the kick and supersede notice.

## Not decided here

- Lobby zoom-in: how long entries of departed players are kept (today's history keeps the newest 50, so a returning player keeps ready and team), whether lobby ignores commands from players absent from `roster`, and the `LobbyPlayer` projection.
- Chat zoom-in: whether history stays local and how it resolves sender names from `roster.players`.
- Resolved in [zoom-5](./zoom-5-game.md): the room layer derives the game's `players`, `removed` and start `setup` from roster and lobby.
- Unproven identity (a claimed `playerId`) is unchanged; see the threat-model doc. A ban is by `playerId`, so it is evaded by minting a new one (a durable ban list is a known candidate).
- A duplicate tab opening during the failover window (all links `connecting`) can win over the older live tab; arbitration settles it afterwards. Check it in the 4a scenarios.

## Size and split

**4a** roster feature (channel, host and guest flows, moderation, derived `players`, fakes). **4b** `joinRoom` and `Room` (scope wiring, join and leave). **4c** minimal UI and the walking-skeleton check.

## Done when

- Two tabs join, rename, refresh a guest (same row, same position), refresh twice quickly (never a double row), refresh the host.
- Killing the host tab keeps the roster consistent after failover, including a ghost that was mid-grace.
- Opening the same `playerId` in a second live tab gets it `superseded`; opening it after the first tab died replaces the first.
- Kick and ban work, and a banned `playerId` cannot rejoin.
- `roster/index.ts` exports only `Roster`; `room` imports features only through their `index.ts`.
- Next: zoom-in 5, game framework (lobby and chat get short feature notes alongside).
