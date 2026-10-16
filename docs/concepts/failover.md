# Failover, election and refresh

Read when changing anything about links, host loss, the host document, or page refresh.

## Why it looks like this

Membership in Firestore says nothing about liveness (there are no heartbeats). Liveness comes from WebRTC links. So a peer is deleted from membership only when someone has a reason, always through `PeerRemover.remove(peerId, reason)`.

## Host dies: the timeline

1. **Detection.** A guest's link to the host closes or fails, or the host never sends an offer within `offerTimeoutMs`. Separately, the host probes its own idle links (`LinkProbe`: ping after 10s of silence, 5s for the pong) and re-links a silent guest. Guests never probe. A guest cares only about the link to the host: a dead link to anyone else is a stale leftover and is dropped (`decideDeadLinkAction`).
2. **Suspicion.** `suspectHostDead` only acts if the peer is the current host. `DeadHostElection.report` registers a `registered` candidacy and starts the 3s collection window. Nothing is removed yet. If the host's link comes back, the election is cancelled.
3. **Window ends.** The host is removed (`suspected-dead`). Each live candidate writes a `confirmed` candidacy and waits 0.7s for the others.
4. **Turns.** Confirmed candidates, filtered to peers still in membership, are sorted by ULID. Position n waits n x 1.5s, then does the atomic `claimHostIf(deadHost, me)`. Any host-document change cancels the other candidates' countdowns.
5. **New host.** Everyone reacts to the host-document change (`WebRtcService.handleHostChanged`): offer watches are cleared, the role is set. The new host offers a link to every peer without one. Existing links are kept open on purpose. Guests start a new offer watch for the new host.
6. **State recovery** (see [messaging](./messaging.md)), then presence and the game host runtime re-derive what they need from replicated state.

Typical total: 5 to 8s. `failover-timeline.test.ts` prints measured milestones. Read them before changing a timer.

## Other ways the host seat changes

- **First election:** no host document on join, so the smallest live ULID is written (`electNextHost`). Also used when the host document is cleared.
- **Handoff:** `transferHost` is one atomic claim by the current host naming the target, which needs an active link.
- **Refresh (reclaim):** a refreshed host returns with a fresh peerId while the host document still names its old one.
  - A per-tab `sessionStorage` hint (`HostClaimStore`) remembers the old peer. `pagehide` stamps it, so a reload within 15s removes the old peer itself and claims at once.
  - Without the stamp (crash), it claims only after the old peer is gone from membership (never while present), retrying until `reclaimWindowMs`.
  - The claim is verified by the atomic write. The hint is only a hint.
  - A deliberate leave, being superseded or being kicked clears the hint, so those never reclaim.
- **Leaving as host:** the host document is cleared so the room elects again.

## Ack timeouts

A peer that never reads its signal inbox is removed after `ackTimeoutMs`, unless its data channel is active (`setAckTimeoutVeto`). Removal after an ack timeout does not clear the inbox (saves a read).

## What fails silently if you break it

- Closing links on a host change: the far side reads a closed link as host death.
- Removing anyone but the current host on suspicion.
- Letting membership pick the election winner: dead peers are still members.
- Skipping `RtcPeerRegistry.remove`'s order (remove from the map first, then close), or closing an entry that is still registered.

See [invariants.md](../invariants.md) for the full list and [timers.md](../timers.md) for the numbers.
