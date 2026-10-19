# Zoom-in 2: transport

Read before touching signaling, links or the star relay. It fixes the transport layer's public API, what stays inside it and what leaves (task 2 of [plan.md](./plan.md)). Written after reading `infrastructure/signaling`, `infrastructure/webrtc`, `infrastructure/player` and how the bus and presence use them today; nothing run or typechecked.

## What transport is

Answers: who is in the room, who is host, which links are up, and what a verified peer sent. It replaces three folders (about 3,600 lines): signaling (Firestore membership, inboxes, host document, election), webrtc (links, reconnect, probes, chunking, reclaim) and the relay half of `PlayerSession`. Its roster half (profiles, directory, `roster` envelopes) is not transport and moves to the roster feature.

The bus already declares what it needs from a transport (`BusTransport` in `messaging/session-transport.ts`: local peer, host peer, `isHost`, send, broadcast, onMessage, onHostChanged, link active, expected and linked peers). The new API is that list, expressed as stores, with nothing roster-shaped left in it.

## Public API

```ts
type Wire = JsonValue                                  // kernel type; transport stringifies, chunks, reassembles
type Member = { peerId: PeerId; joinedAt: number; playerId?: PlayerId }   // playerId: host side only, after the verified hello
type LinkState = "connecting" | "active" | "reconnecting"
type DropReason = "kicked" | "superseded"                 // also what the dropped peer receives
type HandOffReject = "not-host" | "target-unavailable" | "host-changed"
type JoinError = "unavailable"

joinTransport(deps: TransportDeps, params: { roomId: RoomId; playerId: PlayerId }, scope: Scope)
  : Promise<Result<Transport, JoinError>>

interface Transport {
  readonly self: PeerId                                 // fresh per join, ULID, never reused
  readonly role: Store<"guest" | "host">
  readonly host: Store<PeerId | undefined>              // role and host change in one batch
  readonly members: Store<ReadonlyMap<PeerId, Member>>  // membership: who is in the room, says nothing about liveness
  readonly links: Store<ReadonlyMap<PeerId, LinkState>> // host: one per guest; guest: only the host
  send(to: PeerId, msg: Wire): void                     // silently dropped unless the link is active; a guest's send to another guest is relayed by the host
  broadcast(msg: Wire): void                            // to everyone else, any role; relayed by the host; never echoed to the sender
  readonly messages: Listenable<{ from: PeerId; msg: Wire }>   // `from` is host-verified
  drop(peer: PeerId, reason: DropReason): Promise<void>        // host only: send `bye { reason }`, remove from membership, close the link once the `bye` has drained
  readonly dropped: Listenable<DropReason>                     // this peer received a `bye`
  handOff(to: PeerId): Promise<Result<void, HandOffReject>>    // host only
  leave(): Promise<void>                                // idempotent, every remote step best-effort
}
```

- **Joining ties to the session `Scope`.** `joinTransport` registers `leave` on the scope; if the scope is already disposed when the join finishes, the late `add` leaves at once. That replaces the `joined`/`leaving` flags and the subscribe-before-join rule for this layer.
- **No `hostChanged` event.** `host` is a `Store`, so it fires only on a real change, which removes the "repeated host change must not discard synced state" hazard at the source.
- **`members` and `links` are separate stores** because they mean different things (see the glossary: member versus link). The bus's "expected peers" is `links` keys; "linked peers" is the `active` ones; "link became active" is a `watch` on `links`.
- **Sending to yourself does not exist.** Callers handle local delivery. The bus's "own broadcast echoed back" guard goes away with the echo (confirm in the bus zoom-in).

## Guarantees at the boundary

1. **Hello first.** On every new link a guest writes `hello { playerId }` before it reports that link as `active` to anyone, and data channels are ordered, so the host has the binding before any consumer message from that peer. The host stamps `peerId` onto it, so `playerId` is a claim bound to a verified peer.
2. **Hello repeats.** Re-sent when a link becomes active and when the host changes (today's `announceProfileToHost` triggers). A new host rebuilds all bindings from guests' hellos; no replicated binding is needed. This resolves the open point from the proposal. **A binding is final per `peerId`:** a later `hello` claiming another `playerId` is ignored and logged, so a peer cannot rebind itself.
3. **`from` is trusted only as stamped by the host.** A guest sees the host's stamp on relayed messages; claims inside payloads are data.
4. **Only the host's death is inferred from silence.** Election, probes, ack veto and `PeerRemover` rules from the repo's `docs/invariants.md` are untouched, and `drop` is the one way the host removes a live peer.
5. **Links are never closed on a host change;** offer watches are cleared on every host change.
6. **Oversize sends are refused at the sender** (log plus telemetry). Today the receiver drops them silently, which no one sees.
7. **A drop is told, and a told guest never suspects the host.** `drop` writes `bye { reason }` on the link, removes the member, and closes the link only after the `bye` has drained (buffer empty, or `byeFlushMs`), because closing can discard unsent data. A guest that receives `bye` reports `dropped`, closes the link itself and leaves. A guest whose link to the host closes while its own `peerId` is gone from `members` is also `dropped` and never calls `reportSuspectedDeath` (a closed link is read as host death otherwise, per `invariants.md`). Today the notice is a separate one-shot event that races the membership removal.

## Inside (not public)

```
transport/
  index.ts       joinTransport + types           model.ts   Wire, Member, LinkState, ...
  config.ts      assembles signaling + link config   names.ts   frame kinds, telemetry event names
  signaling/     membership, inboxes, host document, election, ack tracker, PeerRemover
  link/          registry, negotiator, factory, reconnect, probe, ICE batcher, chunking, signal router, host role
  relay/         envelope parse, sender stamping, hello, direct and broadcast relay
  claim/         host-seat hint: remember, markLeaving, recall, forget (HostClaimStore + HostSeatKeeper)
  flow.ts        join and leave sequence, host-change sequence (today's WebRtcService shell)
  adapters/      firestore/*, browser-rtc/*     ports.ts   membership, inbox, election, rtc connection, ice servers
  fakes.ts       in-memory versions of every port
```

Inside, the same rule applies one level down: `signaling` knows nothing of `link`; `link` uses `signaling`; `relay` uses `link`; `flow` composes them.

**Moves unchanged:** `DeadHostElection`, `election-order`, `PeerRemover`, the ack tracker, `RtcLinkNegotiator`, `LinkProbe`, `IceBatcher`, chunking, `HostReclaimController`, `decideDeadLinkAction`, the reconnection manager's decisions, the Firestore and browser-RTC adapters.

**Reshaped:**

- `SignalingPeerTracker`, the registry's status events and the role flag become `Cell`s behind the stores above.
- The `cleanupFns` arrays become `Scope`s (`flow` owns the root, `signaling`, `link` and `relay` take children).
- `parseRtcSignal` and `parseEnvelope` use the schema helper (limits `MAX_SDP`, `MAX_CANDIDATE`, `MAX_BATCH` move into link config).
- Firestore paths move to `signaling/names.ts`, and the `host-claim:` key plus `__chunk`/`__probe` literals move to `names.ts`.
- The host-claim hint uses `Storages.tab` and `PageLifecycle` inside transport. Today it is split between `HostClaimStore` (infrastructure) and `HostSeatKeeper` (application), and `multiplayer-client` calls `remember` from two places.

## Config

Two `defineConfig`s inside transport, each key with its descriptor and doc:

- `signaling`: collection and confirm windows, position interval, `ackTimeoutMs`, three retention TTLs.
- `link`: offer, reconnect and reclaim windows, `byeFlushMs`, chunk limits, ICE batching, probe idle and timeout, disconnect grace, signal parser limits, `hostClaimMaxAgeMs`, `iceFetchTimeoutMs`.

Every timer that can remove a live peer (`ackTimeoutMs`, `probeTimeoutMs`, candidate windows) is marked `destructive`. Relations between them (commands outlive a failover, retention outlives its readers) live in `compose/relations.ts` because they cross into bus config.

## What leaves transport

| Today                                                                               | Goes to                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlayerProfile`, `PlayerDirectory`, `roster-diff`, `profile` and `roster` envelopes | roster feature (zoom-in 4)                                                                                                                                     |
| `metadata` bag, `updateLocalProfile`                                                | gone; nickname is a roster command, ready and team are lobby                                                                                                   |
| `PlayerProfileStore` (nickname cookie)                                              | roster feature, over `Storages.profile`                                                                                                                        |
| `/api/turn` fetch in `presentation/room/ice-servers.ts`                             | an `IceServerSource` port in transport deps, wired in `compose`; called per join so TURN credentials are fresh, falling back to STUN after `iceFetchTimeoutMs` |
| `pruneDepartedPlayers` on promotion                                                 | roster, reading `members`                                                                                                                                      |
| `getPeers`/`getPeerIds`/`getMemberPeerIds`/`getPeerConnectionStatus`                | `links` and `members` stores                                                                                                                                   |

## Decisions made here

1. Transport carries `playerId` as its one durable identity, learned by `hello`, and nothing else about a person.
2. `members` and `links` are separate stores; no `hostChanged` event.
3. `broadcast` works from any role and never echoes to the sender; `send` to self does not exist.
4. Join is bound to a `Scope`; `leave()` stays idempotent and awaitable for `Room.leave`.
5. The host-claim hint is owned entirely inside transport.
6. ICE servers come from a port, resolved per join.
7. Sender-side size guard.
8. `drop` sends a `bye`; `dropped` exposes it (added by the roster zoom-in).

## Not decided here

- The bus zoom-in confirms dropping the echo guard and decides who repeats what above this layer.
- Resolved in [zoom-4](./zoom-4-roster-client.md): a duplicate `playerId` is arbitrated by roster, which calls `drop`; the notice is the `bye` frame.
- Exact `Wire` size cap (derived from `maxChunkChars * maxChunksPerMessage` today).

## Size and split

Task 2 is the largest port, because most files move rather than change. Split it:

- **2a** signaling module (move, own config and names, stores for members and host, `PeerRemover` as the one drop path).
- **2b** link module (move, `links` store, ICE source port, chunking and probe unchanged).
- **2c** relay, claim, flow and the `joinTransport` facade, plus fakes.

## Done when

- `index.ts` exports only the API above.
- Two tabs exchange `Wire`, including a message that needs chunking; killing the host tab elects a new host in the usual 5 to 8 s; refreshing the host reclaims the seat; `drop` removes a guest.
- `fakes.ts` lets a multi-peer scenario run in memory (reuse the old `RoomHarness` fakes where they fit).
- Nothing outside transport imports a file from inside it.
- Next: zoom-in 3, bus.
