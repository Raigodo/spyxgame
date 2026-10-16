# Messaging: the bus

Read when touching `RoomBus`, a channel, commands, recovery, or the wire.

## Channel kinds

| Kind        | Owner                                    | Survives host change          | Use for                                                                    |
| ----------- | ---------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| **State**   | host                                     | yes (replicated)              | anything the room must keep: room state, game slot, presence history, bans |
| **Command** | runs on whichever peer is host           | n/a                           | changes to a state channel, as pure reducers                               |
| **Event**   | nobody (ephemeral)                       | no                            | chat, emotes, presence pings. Also delivered locally to the sender.        |
| **Private** | host holds all, each owner holds its own | host copy rebuilt from owners | per-player secrets, see [games](./games.md)                                |

Rule: host-owned data that must survive a host change is a state channel. Ephemeral traffic is an event channel. **Every channel is registered before `bus.start()`** (a late state channel is bootstrapped, but plan for early).

## State and versions

- A state channel value is versioned `(epoch, rev)`. Guests accept only a newer version, from the current host. The same version just confirms they are in sync.
- A new host starts a new epoch. A command bumps `rev`.
- The bus status is `syncing | ready`. A guest is ready only when linked to the host and every channel has been synced. The host is ready when not recovering.

## Commands

- Exactly once per `(sender, seq)`: the high-water mark of applied seq per sender is replicated inside the state, so a new host will not re-run a command it never saw.
- Senders queue unacked commands (30s TTL, longer than the failover budget). They are re-sent on link-up and on a host change.
- Accepted or rejected, a command is marked applied. The ack carries the verdict, and rejections are logged at info on both sides.

## Promotion recovery

A new host may be a freshly refreshed tab with empty state, so it publishes nothing until recovery ends.

1. It broadcasts `recover`. Guests offer their copy of every state channel (guests also offer when their link comes up, so an offer sent before the host knew it was host is never lost).
2. For `recoveryLinkGraceMs` (2s) every peer with a link entry is expected. After that only peers with an active link.
3. Recovery ends when everyone expected offered, or the sliding window (3s) passes, or the cap (10s) hits.
4. The host adopts the newest copy per channel, bumps the epoch, publishes, then runs the commands held during recovery.

Guests re-request snapshots every 3s while unsynced, so a dropped message heals itself. Prefer self-healing repeats like this over more one-shot messages.

## Private channels

The replicated state holds only revisions. Pieces are sent only to their owner, committed **before** the state that references them is published, and offered by their owner during recovery **before** the state offer. Details: [games.md](./games.md).

## Boundaries

- Everything that arrives is parsed once, where it enters: `parseWire`, the envelope parser, per-channel validators. Only the host-verified `from` is trusted.
- Dropped invalid input warns with `{from, kind}`, throttled per sender.
- A new wire kind does not compile until it has a handler in the typed `wireHandlers` table.
