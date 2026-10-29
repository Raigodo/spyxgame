# Transport

Read before touching signaling, links, election, reclaim or the star relay. Transport answers three questions: who is in the room, who is host, and what did a verified peer send. It knows peers and one durable `PlayerId` per peer, and nothing about names, lobbies or games.

## Public API

```ts
joinTransport(deps, { roomId, playerId }, scope): Promise<Result<Transport, "unavailable">>

interface Transport {
  self: PeerId;                                   // fresh per join, ULID, never reused
  role: Store<"guest" | "host">;
  host: Store<PeerId | undefined>;                // role and host change in one batch
  members: Store<ReadonlyMap<PeerId, Member>>;    // membership. Says nothing about liveness
  links: Store<ReadonlyMap<PeerId, LinkState>>;   // host: one per guest. guest: only the host
  send(to: PeerId, msg: Wire): void;              // dropped unless the link is active
  broadcast(msg: Wire): void;                     // everyone else, any role, never echoed
  messages: Listenable<{ from: PeerId; msg: Wire }>; // `from` is host-verified
  drop(peer: PeerId, reason: "kicked" | "superseded"): Promise<void>; // host only
  dropped: Listenable<DropReason>;                // this peer received a `bye`
  handOff(to: PeerId): Promise<Result<void, HandOffReject>>;          // host only
  leave(): Promise<void>;                         // idempotent, every remote step best effort
}
```

- `Member.playerId` is known **on the host only**, after a verified `hello`.
- `LinkState` is `connecting`, `active` or `reconnecting`.
- Joining is tied to the `Scope`: disposing it leaves. If the scope was disposed during the join, the late registration leaves at once.
- Sending to yourself does not exist. Callers deliver locally (the bus does).

## Inside

```
transport/
  flow.ts        joinTransport: builds and wires everything below
  signaling/     membership, inboxes, host document, election, ack tracker, PeerRemover
  link/          registry, negotiator, factory, reconnection, probe, ICE batching, chunking, reclaim
  relay/         envelopes, sender stamping, hello, bye, direct and broadcast relay
  claim/         the per-tab host-seat hint
```

`signaling` knows nothing of `link`; `link` uses `signaling`; `relay` uses `link`; `flow` composes them.

## Firestore data

```
rooms/{roomId}                                   { createdAt, expiresAt }
rooms/{roomId}/signaling-peers/{peerId}          { joinedAt, expiresAt }       membership
rooms/{roomId}/signaling-peers/{peerId}/messages/{id}
                                                 { fromPeerId, timestamp, expiresAt, payload }   inbox
rooms/{roomId}/host/current                      { signalingPeerId, expiresAt }
rooms/{roomId}/election-candidates/{peerId}      { deadHostPeerId, confirmed, expiresAt }
```

Membership has **no heartbeats**. A peer leaves membership only when someone has a reason, always through `PeerRemover.remove(peerId, reason)` where `reason` is `suspected-dead`, `ack-timeout`, `host-removed` or `reclaim`.

## Wire framing

Three layers, each parsed once where it enters:

1. **Frames** on the data channel: plain strings, or `__chunk` frames (a message split into pieces of at most `maxChunkChars`), or `__probe` ping and pong.
2. **Envelopes** (`relay/envelope.ts`): `hello { playerId }`, `bye { reason }`, `app { scope: "broadcast" | "direct", from, to?, msg }`.
3. **Bus messages** (see [Bus](./bus.md)) carried as `msg`.

Messages larger than `maxChunkChars * maxChunksPerMessage` are **refused at the sender** with a warning. Chunk length counts UTF-16 units, not bytes.

## Guarantees

1. **Hello first.** A guest sends `hello { playerId }` when its link to the host becomes active and again on every host change, so a new host rebuilds all bindings. A binding is **final per peer**: a later `hello` claiming another player is ignored and logged.
2. **`from` is trusted only as stamped by the host.** A guest accepts envelopes only from the host peer; claims inside a payload are data.
3. **Only the host's death is inferred from silence.** Guests never probe. Everyone else leaves membership through `PeerRemover` only.
4. **Links are never closed on a host change.** Offer watches are cleared on every host change and re-check that the peer is still host when they fire.
5. **`drop` is told.** The host sends `bye { reason }`, waits `byeFlushMs` for it to drain, then removes the member and closes the link. A guest that receives `bye` emits `dropped`, leaves, and starts no election.

## Host failure

1. **Detection.** A guest's link to the host fails, or is `disconnected` for longer than `disconnectGraceMs`, or no offer arrives within `offerTimeoutMs`. A dead link to anyone else is a stale leftover and is dropped (`decideDeadLinkAction`).
2. **Suspicion.** `reportSuspectedDeath` only acts for the current host. It registers a `registered` candidacy and starts the collection window (`candidateCollectionWindowMs`). Nothing is removed yet; if the host's link returns, the election is cancelled.
3. **Window ends.** The host is removed (`suspected-dead`). Each live candidate writes a `confirmed` candidacy and waits `candidateConfirmWindowMs`.
4. **Turns.** Confirmed candidates still in membership are sorted by id (ULID: oldest first). Position _n_ waits _n_ x `positionIntervalMs`, then does the atomic `claimHostIf(deadHost, me)`. Any host document change cancels the other candidates' countdowns.
5. **New host.** `handleHostChanged` clears offer watches, sets the role, and the new host offers a link to every peer without one.

The host also **probes its own idle links**: ping after `probeIdleMs` of silence, dead after `probeTimeoutMs` without any inbound message. A silent guest is re-linked.

## Other ways the seat changes

- **First election.** No host document on join: the smallest live id (including the local peer) is written.
- **Hand-off.** `handOff(to)` is one atomic claim by the current host naming the target, and needs an active link.
- **Reclaim after a refresh.** A refreshed host returns with a new peer id while the host document still names the old one. A per-tab hint (`host-claim:<roomId>` in `Storages.tab`, holding `{ playerId, peerId, leftAt? }`) remembers the old peer. `pagehide` stamps `leftAt`.
  - Stamp younger than `hostClaimMaxAgeMs`: the new tab removes the old peer itself and claims at once.
  - No stamp (crash): it claims only after the old peer is gone from membership, never while present, retrying until `reclaimWindowMs`.
  - The claim is verified by the atomic write. The hint is only a hint. A deliberate leave or a drop clears it.

## Ack timeouts

Every signal a peer sends is tracked. If the recipient never reads its inbox for `ackTimeoutMs`, and the message is still pending, the recipient is removed (`ack-timeout`), **unless its data channel is active** (the veto). Only host-sent signals use the removing strategy.

## Ports and fakes

Ports: `RoomMembershipPort`, `SignalInboxPort`, `HostElectionPort`, `RtcConnectionProvider`, `IceServerSource`. Real adapters: Firestore and browser RTC. Fakes: `TransportHarness` (`@/transport/fakes`) runs N real transports over one fake Firestore, one fake RTC network and one fake clock. See [Testing](../guides/testing.md).

Settings: [Configuration](../guides/configuration.md).
