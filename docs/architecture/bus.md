# Bus

Read before adding a replicated channel, changing how state is versioned, or debugging failover. The bus is the only user of transport. It turns the verified-sender network into **channels** whose contents survive a host change.

## Public API

```ts
const bus = createBus(deps, scope); // deps: BusDeps = { transport, localPlayerId, clock, ids, log, config }

bus.sync; // Store<"lost" | "syncing" | "ready">
bus.now(); // continuous host time (ms)
bus.state({ id, schema, init, commands }); // replicated, versioned, command-driven -> StateHandle
bus.events({ id, schema }); // fire-and-forget -> EventHandle
bus.priv({ id, schema, of, revisions }); // per-player private pieces -> PrivateHandle
bus.start(); // call once, after every channel is registered
```

**Channels register before `start()`.** Registering later throws, as does a duplicate channel id, because a message could already have arrived for a channel that did not exist. Disposing `scope` ends recovery and resync, and resolves pending sends with `left`.

`sync`: `syncing` = not started, or a host that is still recovering, or a guest with a host link whose state or private channels have not caught up; `lost` = a guest with no active link to the host; `ready` = a host that finished recovery, or a guest whose channels all hold the host's current copy.

## State channels

A state channel holds one value `S`, owned by the host and copied to everyone. `StateHandle` exposes `value: Store<S | undefined>` (undefined until first synced this session), `synced: Store<boolean>`, `send`, `apply`.

```ts
commands: { [type]: { who: "anyone" | "host", schema, reduce(state, payload, ctx) } }
// reduce returns Result<{ state, privateWrites? }, reason>; ctx = { from, fromHost, playerId?, now }
send(cmd): Promise<Result<void, reason | BusReject | "expired" | "left">>; // any peer, queued
apply(cmd): Result<void, reason | BusReject | "not-ready">; // host only, synchronous, not queued
```

- **Version `(epoch, rev)`.** `rev` goes up by one on every real commit. A promotion starts a new epoch (`epoch + 1`, `rev` back to 0). Compared lexicographically; a guest ignores older copies, so a new host's state wins over the old host's late messages. An identical version only confirms the guest is in sync.
- **Commands are the only way to change it.** `reduce` is pure and runs on the host. A command type without a handler does not compile.
- **No-op detection.** A reducer returning the same state reference (and no `privateWrites`) does not bump `rev` and does not broadcast.
- **Validated commits.** The command payload is checked against its spec schema, the new state against the channel schema, and its JSON length against `maxStateChars`. Rejections: `invalid` (also when a reducer throws), `too-large`, `host-only`, `unknown-command`, `unknown-sender` (no hello yet). `BusReject` is the set the bus itself produces; features add their own reasons.
- **Exactly once.** Each command carries `(seq, id)`; `seq` is a per-bus counter and the host keys marks by the sender's peer id. The host keeps the last applied `seq` per sender (`applied`, replicated in the same commit) and answers a repeat with success without re-running it. A rejected command is marked too. Marks of peers no longer members are pruned.
- **Sending.** `send` queues the command and sends it to the current host once per host (again when the host changes or the link comes back up). No ack within `commandTtlMs` resolves `expired`. A host's own `send` runs locally (held while it is recovering).
- **Private writes before the broadcast.** A commit's `privateWrites` go to the private channel first, then the state that refers to them is broadcast.

## Event channels

`EventHandle` has `events: Listenable<{ event, from }>`, `broadcast(event)` and `sendTo(peer, event)`. Both deliver locally to the sender too. Incoming events are validated with the spec schema, not stored, not replayed, not versioned. Use them for things that are true only at the moment (a tap animation, a toast). Anything a late joiner must see belongs in state.

## Private channels

`bus.priv({ id, schema, of, revisions })`: `of` is the state handle whose commits carry the pieces; `revisions(state)` returns `{ round, rev: Record<PlayerId, number> } | undefined`. A piece is current only if its `(round, rev)` matches those revisions. `PrivateHandle` has `mine: Store<P | undefined>` and `view(playerId)` (host side). Pieces are written by a reducer's `privateWrites` (`{ playerId, round, rev, value | null }`). The host holds every piece in memory, never in the replicated state, and sends each to its owner's link; a guest holds only its own. Other players never receive it.

## Wire

Everything rides in `__bus` version 1 messages, parsed once in `wire.ts` (unknown or invalid input is dropped with a throttled warning):

| Kind      | From     | Purpose                                                                           |
| --------- | -------- | --------------------------------------------------------------------------------- |
| `state`   | host     | One channel's copy: `ch, epoch, rev, asOf` (host time), `value, applied`          |
| `offer`   | guest    | Its copies of all state channels, sent to the host on link up and on `recover`    |
| `sync`    | guest    | `{ ch }`: "I lack this channel". Repeated every `resyncIntervalMs` while unsynced |
| `command` | guest    | `ch, id, seq, type, payload`                                                      |
| `ack`     | host     | `id, ok, reason?` verdict for a command                                           |
| `event`   | any      | `ch, event`                                                                       |
| `recover` | new host | Asks every guest to offer                                                         |
| `private` | host     | A player's piece (`ch, round, rev, value`), sent to its owner                     |
| `mine`    | guest    | Its own piece (or none) to the host; also how it asks for it again                |

Repeating messages (`sync`, `offer`, `mine`) are the self-healing mechanism: a lost message is replaced by the next one, not by a special recovery path. The host ignores `sync` while recovering; the guest asks again.

## Promotion recovery

When this peer becomes host (`BusRecovery`):

1. It broadcasts `recover`. Guests answer with `mine` pieces first, then an `offer` with their copy and `(epoch, rev)` of every state channel (they also offer whenever a link to the host comes up).
2. It finishes as soon as every expected peer has offered (vacuous with no peers). Expected = every peer in the links map until `recoveryLinkGraceMs`, then only peers with an active link.
3. Otherwise it waits in a **sliding window**: `recoveryWindowMs` after the last activity (an offer or a link coming up), never longer than `recoveryMaxMs` from promotion.
4. It adopts the strictly newest copy per channel (own copy included), continues host time, prunes `applied`, calls `promote()` (new epoch, publish), accepts offered private pieces, then runs the commands it held while recovering.

Until it finishes, `sync` is `syncing`, `apply` returns `not-ready`, and guest commands are held.

Failover budget, worst case when the electing candidate is third in line (two earlier ones fail to claim): `candidateCollectionWindowMs + candidateConfirmWindowMs + 2 x positionIntervalMs + recoveryMaxMs` = 3000 + 700 + 2 x 1500 + 10000 = 16.7 s, below `commandTtlMs` (30 s). The first three are transport's (`src/transport/config.ts`); the sum excludes the time to detect the host's death. The relation is documented, not machine-checked.

## Time

`bus.now()` is host time: local clock plus an offset. A guest raises the offset from the `asOf` of each accepted `state` copy (it never goes backwards). A new host continues from the newest `asOf` among offered copies with `epoch > 0`, so countdowns agree across peers and carry on across a failover without a jump.

## Adding a channel

1. Define the def (`id`, `schema`, `init`, `commands`) in the owning feature.
2. Register it with `bus.state(...)` before `bus.start()`.
3. Expose a `Store` and intent methods from the feature; never the channel itself.

See [Roster](./roster.md) and [Game framework](./game-framework.md) for the two existing users. Settings: [Configuration](../guides/configuration.md#bus).
