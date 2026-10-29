# Architecture overview

Read first. It describes the whole system in one page and tells you which page to open next.

## Goal and priorities

A browser board-game framework. A game is one typed definition plus a page. Networking, presence, recovery and state replication are never touched per game.

Priorities, in order:

1. **Resilience.** Self-healing connections, host failover, host reclaim after a refresh, duplicate-tab arbitration. Prefer repeating, self-healing messages to one-shot ones.
2. **Readable code that is cheap to change.** One behavior, one small module.
3. **Testable and modular.** Every outside-world dependency is an injected port; decisions are pure functions.
4. **Minimal Firestore usage.** No heartbeats, no polling, no new reads without a clear need.

## Topology

- Players talk **peer to peer** over WebRTC data channels (ordered, reliable, label `data`).
- **Star:** the host connects to every guest. Guests talk only to the host, which relays broadcasts and direct messages and stamps the verified sender. Guest-to-guest links are never opened.
- **Firestore is signaling only:** room membership, per-peer signal inboxes (offer, answer, ICE batches), the host document, election candidates.
- **The host is elected, not fixed.** All shared state is host-owned but replicated, so any guest can take over. Host loss is a normal event.
- **ICE:** Google STUN, plus optional relay servers from `/api/turn`. Any failure means STUN only.

## Layers

```
ui          React: RoomProvider, hooks, screens
  |
room        joinRoom -> Room: one join, one Scope, one object for the UI
  |
roster | game                    (peers: never import each other)
  |
bus         replicated channels: state, event, private
  |
transport   star network: peers, host, verified sender
  |
kernel      Store, Scope, Result, schema, config, ports, ids
```

| Layer     | Answers                                                                | Page                                  |
| --------- | ---------------------------------------------------------------------- | ------------------------------------- |
| kernel    | Building blocks and port interfaces                                    | [Kernel](./kernel.md)                 |
| transport | Who is connected, who is host, what did a verified peer send           | [Transport](./transport.md)           |
| bus       | How shared state stays replicated and versioned across host change     | [Bus](./bus.md)                       |
| roster    | Who is in the room, and who may not be                                 | [Roster](./roster.md)                 |
| game      | Which game runs, its state, who may do what, what the host does for it | [Game framework](./game-framework.md) |
| room      | The one object the UI talks to                                         | [Room](./room.md)                     |

## Three flows

### Joining

1. The UI calls `joinRoom(deps, { roomId })`. A `playerId` is minted if absent.
2. `joinTransport` resolves ICE servers, joins Firestore membership, reads or elects the host and starts linking.
3. The bus, roster and game are built on the same `Scope`, registering their channels.
4. `bus.start()` runs. A guest sends `join` until the replicated roster holds its row.

### One command, end to end

1. A page calls `handle.send(command)`. The game wraps it in a `play` command on the `game` channel.
2. The bus queues it with a sequence number and sends it to the host (the host runs it locally).
3. The host checks that the sender is bound to a player, runs the play gate, validates the payload and runs the pure reducer.
4. The result is validated against the channel schema and size cap, then committed: `rev` goes up, private pieces go to their owners, the new state is broadcast.
5. The sender gets an ack with the verdict. Every peer's stores update, so React re-renders.

### Host failure

1. A guest sees its link to the host die, or never gets an offer. It suspects the host and registers as an election candidate.
2. After a collection window the dead host is removed from membership. Live candidates confirm, and the confirmed ones are ordered by peer id.
3. Position _n_ waits _n_ intervals, then claims the host document with an atomic write. One wins.
4. Everyone reacts to the host document change. Links are kept open. The new host links to anyone it has no link to.
5. The new host asks guests for their copies of every state channel, adopts the newest, starts a new epoch and publishes.
6. Roster and game re-derive what they need from the replicated state.

Detail and timers: [Transport](./transport.md#host-failure), [Bus](./bus.md#promotion-recovery). The old measurement was about 5 to 8 seconds end to end. That number has not been re-measured on the rewritten code.

## Rules that hold everywhere

- **State is a `Store<T>`; moments are `Listenable<E>`.** Derived values are derived stores.
- **Intents return `Result<T, Reason>`** and never throw for expected failures.
- **Network input is untrusted** and parsed once, where it enters. Only the host-verified sender is trusted.
- **Everything outside the process is an injected port.** No `setTimeout`, `Date.now`, `crypto`, `window`, `console` or storage access below `adapters/` and `compose.ts`.
- **Numbers and names live in `config.ts` and `names.ts`.**

Full list: [Invariants](../reference/invariants.md), [Conventions](../reference/conventions.md).
