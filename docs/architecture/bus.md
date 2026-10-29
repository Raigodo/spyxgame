# Bus

Read before adding a replicated channel, changing how state is versioned, or debugging failover. The bus is the only user of transport. It turns the verified-sender network into **channels** whose contents survive a host change.

## Public API

```ts
const bus = createBus(deps, scope); // deps: transport, clock, ids, logger, config

bus.sync; // Store<"lost" | "syncing" | "ready">
bus.now(); // continuous host time (ms)
bus.state(id, spec); // replicated, versioned, command-driven
bus.events(id, spec); // fire-and-forget broadcasts
bus.priv(id, spec); // per-player private pieces
bus.start(); // call once, after every channel is registered
```

**Channels register before `start()`.** Registering later throws, because a message could already have arrived for a channel that did not exist.

`sync`: `lost` = no host link, `syncing` = a host exists but a channel has not caught up, `ready` = all state channels hold the host's current `(epoch, rev)`.

## State channels

A state channel holds one value `T`, owned by the host and copied to everyone.

- **Version `(epoch, rev)`.** `rev` goes up on every real change. `epoch` goes up when a new host takes over. Compared lexicographically, so a new host's state always wins over the old host's late messages.
- **Commands are the only way to change it.** `send(command)` from any peer; `apply(command)` on the host only, synchronous. The spec supplies a pure `reduce(state, command, ctx) -> state | rejection`.
- **No-op detection.** A reducer returning the same reference does not bump `rev` and does not broadcast.
- **Validated commits.** Every commit is checked against the channel schema and `maxStateChars`. A failing commit is rejected (`invalid` or `too-large`) and state is unchanged.
- **Exactly once.** Commands carry `(sender, seq)`. The host keeps the last applied seq per sender and ignores repeats. `send` retries until acked or its TTL (`commandTtlMs`) runs out. Applied marks are replicated, and pruned for members who have left.
- **Private writes before the broadcast.** If a commit produced private pieces, they go to their owners first, then the state that refers to them is broadcast.

## Event channels

`events(id, spec)` gives `emit(event)` (host or guest) and an `on` listenable. Events are validated, not stored, not replayed, and not versioned. Use them for things that are true only at the moment (a tap animation, a toast). Anything a late joiner must see belongs in state.

## Private channels

`priv(id, spec)` holds per-player pieces. The host stores every player's piece; each player's own copy is delivered with `mine` messages and exposed as a store. Other players never receive it.

## Wire

Everything rides in `__bus` v1 messages:

| Kind      | From     | Purpose                                                                                     |
| --------- | -------- | ------------------------------------------------------------------------------------------- |
| `state`   | host     | Full state with `(epoch, rev)`                                                              |
| `offer`   | guest    | A guest's copy of a state channel during recovery                                           |
| `sync`    | guest    | "I am behind": asks for the current state. Repeated every `resyncIntervalMs` while unsynced |
| `command` | guest    | Command with `(seq, ttl)`                                                                   |
| `ack`     | host     | Verdict for a command                                                                       |
| `event`   | any      | Event channel payload                                                                       |
| `recover` | new host | Asks every guest for `offer`                                                                |
| `private` | guest    | Private command                                                                             |
| `mine`    | host     | A player's own private piece                                                                |

Repeating messages (`sync`, `command`) are the self-healing mechanism: a lost message is replaced by the next one, not by a special recovery path.

## Promotion recovery

When this peer becomes host:

1. It broadcasts `recover`.
2. Every guest answers with an `offer` per state channel holding its copy and `(epoch, rev)`.
3. The new host waits in a **sliding window**: `recoveryWindowMs` after the last offer, never longer than `recoveryMaxMs`. It also waits `recoveryLinkGraceMs` for links that are still reconnecting.
4. It **adopts the newest** copy per channel (own copy included), starts a new epoch, publishes, and then runs commands it held while recovering.

Failover budget: `candidateCollectionWindowMs + candidateConfirmWindowMs + 2 x positionIntervalMs + recoveryMaxMs` = 3000 + 700 + 3000 + 10000 = 16.7 s, below `commandTtlMs` (30 s), so a command sent just before the host died is still delivered after it.

## Time

`bus.now()` is host time: the host's clock offset is measured from `state` messages, so countdowns agree across peers and keep going across a failover without a jump.

## Adding a channel

1. Define a spec (schema, `reduce`, `initial`) in the owning feature.
2. Register it with `bus.state(...)` before `bus.start()`.
3. Expose a `Store` and intent methods from the feature; never the channel itself.

See [Roster](./roster.md) and [Game framework](./game-framework.md) for the two existing users. Settings: [Configuration](../guides/configuration.md#bus).
