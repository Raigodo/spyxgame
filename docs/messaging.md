# Messaging model (the bus)

- Three kinds: **state** (host-owned replicated value), **command** (pure reducer run on whichever peer is host), **event** (ephemeral, delivered locally to the sender too).
- State is versioned by (epoch, rev). Guests accept only newer versions from the current host.
- Commands are exactly-once per (sender, seq) via replicated high-water marks. Senders queue unacked commands (30s TTL) and re-send on link-up or host change.
- Each game has its own state channel `game:<id>`. Room state is separate. Presence has `presence:history` (departed players' metadata, newest 50, fed by `remember` commands from every peer) and `presence:bans` (banned playerIds, newest 100).
- Rule: host-owned data that must survive a host change is a state channel; ephemeral traffic is an event channel.
- All channels are registered before `bus.start()`.
- All network input is parsed at the boundary (`wire.ts`, envelope-parser, per-channel validators).

## Promotion recovery

A new host asks for copies, guests offer theirs, the host adopts the newest, then publishes with epoch+1.

- It waits for expected peers. For `recoveryLinkGraceMs` (2s) every peer with a link entry is expected; after that only peers with an active link.
- Sliding window 3s, cap 10s.
- Guests re-request snapshots every 3s while unsynced.
- Status is `syncing | ready`.
- Commands that arrive during recovery are held and run after publishing.
