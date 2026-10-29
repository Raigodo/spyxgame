# Invariants

Read before any change that touches transport, bus, roster or room. These must never break. Code wins on detail, this page wins on intent.

## Trust

- Network input is untrusted and validated where it enters. Only the host-verified sender is trusted.
- `playerId` is durable; `peerId` is fresh per join and never reused.
- A binding of peer to player is final per peer.

## Host and death

- Only the current host's death may be inferred from a closed link or a missed offer. `reportSuspectedDeath` is destructive.
- Other peers leave membership only through `PeerRemover`.
- Links are never closed on a host change. Offer watches are cleared on every host change.
- Failover budget stays below `commandTtlMs`.

## State

- Reducers are pure functions of (state, payload).
- State changes only through commands. A same-reference result is not a change.
- State is versioned by `(epoch, rev)`; the newer always wins.
- Commands apply exactly once per `(sender, seq)`.
- Private writes reach owners before the state that references them is broadcast.

## Lifecycle

- Teardown order: client wiring, bus, presence, session. `leave` is idempotent.
- Channels register before `bus.start()`.

## Firestore

- No heartbeats or polling. No new reads unless clearly needed.
- Prefer repeating self-healing messages to one-shot ones.

## Code

- Everything outside the process is an injected port.
- No React hooks below presentation.
- TURN secrets are server-side only, never `NEXT_PUBLIC_`.
