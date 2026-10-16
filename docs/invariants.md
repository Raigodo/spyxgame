# Invariants (never break) and why

## Liveness and removal

- Only the current host's death may be inferred from a closed link or missed offer. Reporting anyone else removes a live peer and triggers spurious elections.
- Another peer is deleted from membership only through `PeerRemover.remove(peerId, reason)`.
- `reportSuspectedDeath` is destructive: the host is removed when the collection window ends without its link returning, never at suspicion time.
- An ack timeout never removes a peer whose data channel is active (`setAckTimeoutVeto`).
- Only the host probes links. A probe failure takes the normal dead-link path. Guests never infer anything from silence.
- The election never trusts membership to pick a winner: only confirmed candidates, claimed atomically.

## Links and host changes

- Never close links on a host change. The other side reads a closed link as host death. Stale guest-to-guest links are harmless.
- Offer watches are cleared on every host change and re-check that the peer is still host when they fire.
- Host-change events can repeat for the same host and must not discard synced state.
- `RtcPeerRegistry.remove` removes first, then closes, because closing fires "connection died". Only `handleConnectionDied` closes an entry while it is still registered, to replace it.
- Sends silently drop when a link is not active; broadcast is exception-safe per peer.
- Prefer self-healing repeats (periodic snapshot request, hello, offer-on-link-up) over more one-shot messages.

## Identity and trust

- `playerId` is durable; `peerId` is fresh per join and never reused (a fresh session stack per join).
- Network input is untrusted. Only the host-verified `from` is trusted; the host relays the stamped envelope.

## State and presence

- Reducers are pure functions of (state, payload), so a new host can continue from replicated state.
- A pong travels guest to host, so it is handled before host-only guards.
- A ping before the link is active is silently dropped and makes a live tab look like a ghost. After promotion, arbitration waits for links (8s cap).
- On a departure, the survivor's metadata is restored before the duplicate view fires its reveal.
- Getters on `MultiplayerClient` return stable references between changes.

## Lifecycle

- Teardown order: client wiring, bus, presence, session. `leaveRoom` is idempotent and every remote step is best-effort.
- Firestore: no new reads or polling without a clear need.

## Game

- Effects are plain data in the slot; the host runtime acts on endRequested and never emits notices itself.
- A timer is removed in the same publish that applies its handler (exactly once). Game logic never reads the clock; deadlines are display data.
- A private piece is sent only to its owner and is never in the slot or a broadcast. A demoted host drops everyone else’s pieces. A piece is shown only if its round and revision match the replicated state.
