# Invariants

Read before changing `src/shared`. These must never break. Each one fails silently or intermittently, so the "why" matters.

## Liveness and removal

- Only the current host's death may be inferred from a closed link or a missed offer. Reporting anyone else removes a live peer and starts spurious elections.
- Another peer leaves membership only through `PeerRemover.remove(peerId, reason)`.
- `reportSuspectedDeath` is destructive: the host is removed when the collection window ends without its link returning, never at suspicion time.
- An ack timeout never removes a peer whose data channel is active.
- Only the host probes links. Guests never infer anything from silence.
- The election never trusts membership to pick a winner: only confirmed candidates, claimed atomically.

## Links and host changes

- Never close links on a host change: the other side reads a closed link as host death.
- Offer watches are cleared on every host change and re-check that the peer is still host when they fire.
- A repeated host-change event for the same host must not discard synced state.
- `RtcPeerRegistry.remove` removes first, then closes (closing fires "connection died"). Only `handleConnectionDied` closes a still-registered entry, to replace it.
- Sends silently drop when a link is not active. Broadcast is exception-safe per peer.

## Identity and trust

- `playerId` is durable. `peerId` is fresh per join and never reused (a fresh session stack per join).
- Network input is untrusted and parsed where it enters. Only the host-verified `from` is trusted; the host relays the stamped envelope.

## State, commands, games

- Reducers (commands, timer handlers, `presence.onChange`) are pure functions of their input, so a new host can continue from replicated state.
- Presence changes in a game slot are written only by the host runtime, in one publish with the game's `onChange` result.
- Effects are plain data in the slot. The host runtime acts on `endRequested` and never emits notices itself.
- A timer is removed in the same publish that applies its handler (exactly once). Game logic never reads a clock; deadlines are display data.
- A private piece goes only to its owner and is never in the slot or a broadcast. It is committed before the slot referencing its revision is published. A demoted host drops everyone else's pieces. A piece is shown only if its round and revision match the replicated state.
- A game slot from a newer build is rejected. A missing field from an older build defaults; a malformed one rejects.
- Getters on `MultiplayerClient` return stable references between changes.

## Presence

- A pong travels guest to host, so it is handled before host-only guards.
- A ping before the link is active is dropped and makes a live tab look like a ghost. After promotion, arbitration waits for links (8s cap).
- On a departure, the survivor's metadata is restored before the duplicate view fires its reveal.

## Lifecycle

- Teardown order: client wiring, bus, presence, session. `leaveRoom` is idempotent and every remote step is best-effort.
- Firestore: no new reads or polling without a clear need.
- Below presentation, no direct `setTimeout`, `Date.now`, `crypto`, `window`, `document`, `sessionStorage`, `localStorage` or `console`. Use the injected ports.
