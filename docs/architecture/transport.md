# Transport

Read before touching signaling, links, election, reclaim or the star relay. Transport answers three questions: who is in the room, who is host, and what did a verified peer send. It knows peers and one durable `PlayerId` per peer, and nothing about names, lobbies or games.

## Public API

```ts
joinTransport(deps, { roomId, playerId }, scope): Promise<Result<Transport, JoinError>>   // JoinError = "unavailable"

interface Transport {
  self: PeerId;                                   // fresh per join, ULID, never reused
  role: Store<"guest" | "host">;
  host: Store<PeerId | undefined>;                // role and host change in one batch
  members: Store<ReadonlyMap<PeerId, Member>>;    // membership. Says nothing about liveness
  links: Store<ReadonlyMap<PeerId, LinkState>>;   // host: one per guest. guest: only the host
  send(to: PeerId, msg: Wire): void;              // dropped unless the link is active; guest to guest goes via the host
  broadcast(msg: Wire): void;                     // everyone else, any role, relayed by the host, never echoed
  messages: Listenable<{ from: PeerId; msg: Wire }>; // `from` is host-verified
  drop(peer: PeerId, reason: DropReason): Promise<void>;           // host only; no-op otherwise or for self
  dropped: Listenable<DropReason>;                // this peer received a `bye`
  handOff(to: PeerId): Promise<Result<void, HandOffReject>>;          // host only
  leave(): Promise<void>;                         // idempotent, every remote step best effort
}
```

- `Wire` is any JSON value. `DropReason` is `"kicked" | "superseded"`. `HandOffReject` is `"not-host" | "target-unavailable" | "host-changed"`.
- `Member` is `{ peerId, joinedAt, playerId? }`. `playerId` is known **on the host only**, after a verified `hello`.
- `LinkState` is `connecting`, `active` or `reconnecting`.
- Joining is tied to the `Scope`: disposing it leaves. If the scope was disposed during the join, the late registration leaves at once.
- Sending to yourself does not exist. Callers deliver locally (the bus does).

## Inside

```
transport/
  flow.ts        joinTransport: builds and wires everything below
  signaling/     membership, inboxes, host document, election, ack tracker, PeerRemover
  link/          LinkService, registry, negotiator, link factory, host role, signal router, reconnection,
                 probe, ICE batching, chunked messenger, host reclaim controller
  relay/         envelopes, sender stamping, hello, bye, direct and broadcast relay
  claim/         HostClaim: the per-tab host-seat hint
  config.ts      signalingConfig, linkConfig    names.ts  FRAME literals, claim key prefix
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

Membership has **no heartbeats**. A peer deletes its own membership on `leave`; removing another peer always goes through `PeerRemover.remove(peerId, reason)` where `reason` is `suspected-dead`, `ack-timeout`, `host-removed` (default, used by `drop`) or `reclaim`. Everything except `ack-timeout` also clears the removed peer's inbox.

## Wire framing

Three layers, each parsed once where it enters:

1. **Frames** on the data channel: plain strings, or `{"__chunk":true,messageId,index,total,data}` frames (a message split into pieces of at most `maxChunkChars`), or `{"__probe":"ping"|"pong"}`. Probe frames never reach the relay.
2. **Envelopes** (`relay/envelope.ts`, JSON, tagged by `kind`): `hello { playerId }`, `bye { reason }`, `app { scope: "broadcast" | "direct", from, to?, msg }` (`to` required for `direct`). Invalid ones are dropped with a throttled warning.
3. **Bus messages** (see [Bus](./bus.md)) carried as `msg`.

An encoded envelope larger than `maxChunkChars * maxChunksPerMessage` is **refused at the sender** with a warning. Chunk length counts UTF-16 units, not bytes.

## Guarantees

1. **Hello first.** A guest sends `hello { playerId }` when its link to the host becomes active and again on every host change, so a new host rebuilds all bindings. A binding is **final per peer**: a later `hello` claiming another player is ignored and logged.
2. **`from` is trusted only as stamped by the host.** A guest accepts envelopes only from the host peer and ignores its own; the host overwrites `from` with the link's peer; claims inside a payload are data.
3. **Only the host's death is inferred from silence.** Only the host probes. Everyone else is removed through `PeerRemover` only.
4. **Links are never closed on a host change.** Offer watches are cleared on every host change and re-check that the peer is still host when they fire.
5. **`drop` is told.** The host sends `bye { reason }`, waits `byeFlushMs` for it to drain, then removes the member (`host-removed`) and closes the link. A guest that receives `bye` emits `dropped`, leaves, and starts no election.

## Host failure

1. **Detection.** A guest's link to the host fails, closes, or stays `disconnected` longer than `disconnectGraceMs`, or no active link to a new host appears within `offerTimeoutMs`. A dead host link also starts `reconnectTimeoutMs`: with no replacement offer the local entry is dropped. A dead link to anyone else is a stale leftover and is dropped (`decideDeadLinkAction`).
2. **Suspicion.** `reportSuspectedDeath` only acts for the current host. It is idempotent per host. It writes a `registered` candidacy, then starts the collection window (`candidateCollectionWindowMs`). Nothing is removed yet; if the host's link returns, the election is cancelled.
3. **Window ends.** The host is removed (`suspected-dead`). Each live candidate writes a `confirmed` candidacy and waits `candidateConfirmWindowMs`.
4. **Turns.** Confirmed candidates for that host who are still in membership (or are me) are sorted by id (ULID: oldest first). A local peer missing from the list stops. Position _n_ waits _n_ x `positionIntervalMs`, then does the atomic `claimHostIf(deadHost, me)`. Any host document change cancels the other candidates' countdowns; the winner clears all candidacies.
5. **New host.** `handleHostChanged` clears offer watches, sets the role, and a new host offers a link to every peer without one. A guest starts a new offer watch.

The host also **probes its own idle links**: ping after `probeIdleMs` without inbound messages, dead if still nothing arrives `probeTimeoutMs` after the ping (any inbound message counts). A silent guest is re-linked with a fresh offer (`reconnecting`).

## Other ways the seat changes

- **First election.** No host document on join, or the document is cleared: the smallest live id (including the local peer) is written by `electNextHost`.
- **Hand-off.** `handOff(to)` is one atomic claim by the current host naming the target, and needs this peer to be host and an active link to the target (`not-host`, `target-unavailable`, `host-changed` otherwise).
- **Reclaim after a refresh.** A refreshed host returns with a new peer id while the host document still names the old one. Whenever this peer becomes host, a per-tab hint (`host-claim:<roomId>` in `Storages.tab`, holding `{ playerId, peerId, leftAt? }`) remembers its peer. `pagehide` on the host stamps `leftAt`. On join the hint is used only for the same `playerId`, and only if the host document still names that old peer.
  - Stamp younger than `hostClaimMaxAgeMs`: the new tab removes the old peer itself (`reclaim`) and claims at once.
  - No stamp (crash): it claims only after the old peer is gone from membership, never while present, retrying on each membership departure, with a final attempt at `reclaimWindowMs`. The window also ends when the host document names anyone else.
  - The claim is verified by the atomic write. The hint is only a hint. A deliberate leave or a drop clears it.

## Ack timeouts

Every signal a peer sends is tracked per recipient (the latest one wins). Any signal arriving from the recipient is an ack. After `ackTimeoutMs` without one, if the message still exists in the inbox (one read), the recipient is removed (`ack-timeout`, inbox left alone), **unless its link is active** (the veto). Only host-sent offers and ICE batches use the removing strategy; answers never do.

## Ports and fakes

Ports: `RoomMembershipPort`, `SignalInboxPort`, `HostElectionPort`, `RtcConnectionProvider`, `IceServerSource`. Real adapters: Firestore and browser RTC. Fakes: `TransportHarness` (`@/transport/fakes`) runs N real transports over one fake Firestore state, one fake RTC network and one fake clock. See [Testing](../guides/testing.md).

Settings: [Configuration](../guides/configuration.md).
