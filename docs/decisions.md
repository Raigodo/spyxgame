# Decision log

Grouped by topic. If a decision is reversed, edit the entry instead of appending.

## Identity and ids

- ULID peer ids: the election picks the smallest id, so ids that sort by creation time make the longest-present player win. Clock skew can skew this; accepted.
- One id format everywhere, so a stray generator cannot break the ordering rule.

## Liveness, removal and election

- Staying on WebRTC link death plus Firestore signaling, not Realtime Database. Improvement by measuring (`failover-timeline.test.ts`, `milestones.ts`), then tightening.
- Every deletion of another peer goes through `PeerRemover.remove(peerId, reason)` (`suspected-dead`, `ack-timeout`, `host-removed`, `reclaim`): one debug line, per-reason counts in `inspect()`, inbox cleared except after an ack timeout.
- A suspected host is removed only when the collection window ends without its link returning. Each live candidate then writes a `confirmed` doc, waits `candidateConfirmWindowMs`, and the first confirmed position claims the seat with atomic `claimHostIf(deadHost, me)`. Membership is never used to pick the winner. Cost: one extra write per candidate.
- `HostElectionService` keeps the host document; `DeadHostElection` owns the post-death sequence and its countdowns.
- An ack timeout for a peer with an active data channel is vetoed (peer stays, warning logged). No "fragile" status: real death is caught by connection-state detection.
- The host probes idle links (`LinkProbe`); a failure goes through the normal dead-link path. Guests never probe.
- Timers tightened: candidate window 5s to 3s, position interval to 1.5s. The window stays at 3s because it is also the unstamped-reclaim grace.
- Ghost grace 10s to 4s so a dead host's row leaves sooner; a slower reload shows as a new join, restore is unaffected. Skipping the ghost only for a replaced host was rejected (ordering race).

## Reclaim and refresh

- A per-tab sessionStorage hint names the old peer. pagehide stamps it, so a reload within 15s removes the old peer itself and claims at once. Without the stamp the slow safe path runs (never claim while the old peer is present).
- Reclaim is a hint, verified by an atomic `claimHostIf`.
- `HostSeatKeeper` owns the hint rules. The room creator's seat is remembered by a watcher subscribed before `join()` (using the minted peerId) and dropped after `bus.start()`.
- A newly promoted host prunes roster entries whose membership doc is gone, and `WebRtcService.removePeer` cleans up locally, because the membership snapshot may never fire.
- `RtcPeerRegistry.remove` owns the "remove, announce, then close" order.

## Presence

- Departed players show as local "reconnecting" ghost rows (4s). Local, not replicated. Kick sends a `farewell`. A player never sees a row for their own previous incarnation. Ghost rows count as players during a refresh.
- Presence split: `PresenceBook` (data), `DuplicateView`, `DuplicateArbiter`; the coordinator dispatches and keeps two orders: pong before host-only guards, survivor restore before the reveal. Pinned by `presence-scenarios.test.ts`.
- Presence history is the replicated `presence:history` channel (50 max, same player replaces its entry); every peer reports departures; a promoted host restores itself once, within `linkWaitMs`, filling only missing keys.
- Bans: replicated `presence:bans` channel (100 max, per room). Applied in visibility: hidden on every peer, never a ghost, a ban change re-projects the roster.
- Spy resolves phases through one pure settle; the reducers only record the action.

## Messaging and bus

- RoomBus split: channels in their own files, `BusRecovery` for collection, wire kinds in a typed `wireHandlers` table. `this.recovery` is cleared before channels publish.
- Recovery waits for every linked-or-linking peer for `recoveryLinkGraceMs`, then only active links.
- Chunked envelopes claiming `__chunk` are validated (bounds, 256 max); malformed ones are dropped.
- `PlayerSession` validates every envelope and filters invalid roster profiles.
- Signals are opaque to signaling; the RTC layer owns `RtcSignal` and validates every incoming one. ICE candidates leave in batches (`ice-batch`).

## Client

- Derived client values are kernel `Store<T>`s behind a getter and `on...` pair; hooks share `useClientValue`.
- Client split: `HostSeatKeeper`, `ClientGameBackend`, `RosterView`, `ClientLifecycle`; the client is wiring plus delegation. General "wire before join" was not done: the coordinator and bus seed their state from the joined session.
- Lobby: one `LobbyModule` with the mode as data and rules in `lobby-rules.ts`. Change detection uses `structurallyEqual` over whole players, including metadata.
- Players carry `isHost` (`RoomPlayer`); unused client API was removed. Lobby buttons are disabled while the room is not `ready`.
- One `{ definition, route }` entry per game (`createGameRegistry`); duplicates or bad routes throw at load.
- `use*` is reserved for hooks (`getGame`). "Session" means `SignalingSession` or `PlayerSession` only; `onSuperseded` at every level.

## Firestore cost

- New docs carry an `expiresAt` from the injected Clock; TTL policies on `rooms`, `signaling-peers`, `messages`, `election-candidates`, `host`. Transients 1h, long-lived 7d, no heartbeat refresh. Saves storage, not reads.
- ICE batching (300ms window, 20 max) cuts signal docs; unmeasured on real networks.

## Logging, debugging, errors

- Per-scope levels via `NEXT_PUBLIC_LOG_SCOPES="bus:debug"`. Listener errors use `listenerFailure`. Dropped invalid input warns with `{from, kind}`, throttled per sender with a `suppressed` count. Command rejections log at info on both sides.
- Stateful classes expose read-only `inspect()` (ids and counters only). `MultiplayerClient.getDebugState()` composes them and is exempt from the getter-plus-callback rule. `window.__room()` exists in non-production builds only.
- `leaveRoom` runs every remote step best-effort; local state always resets. Fire-and-forget promises use `logFailure`.
- Every `on...` returns its own `Unsubscribe`; `clear()` is only for owner teardown.
- `isRecord` and `isInt` live only in `kernel/guards.ts` (tested). `PlayerSession` uses the injected Clock. The cookie adapter URI-encodes names.

## Testing

- `RoomHarness` runs N real clients over fake Firestore, fake RTC and one `FakeClock` (each tab has a `ScopedClock`). `kill(detectionMs)` simulates a dead tab, `refresh()` a reload, `silence()` a silent link. Approximations are documented on the class. `firestore.stats` counts reads, writes and deletes.
- The harness waits with `setImmediate`, not `setTimeout(0)` (Windows timer granularity). Do not use `vi.useFakeTimers()` with it. It keeps the real timer config so timelines stay meaningful.
- Timers: every one in `config.ts` has a row in `docs/timers.md`; a test enforces that and the relations.

## Docs

- Docs live in `design.md` (overview), `docs/` (reference) and `conventions.md` (rules). Tests that read docs find tables by row prefix, not by section number.

## Games

- Reducers may return effects: emit records a replicated, round-scoped notice (newest 50, validated by the game’s events), end sets slot.endRequested and the host runtime ends the game once per round. Notices live in the slot, so they survive failover and refreshed tabs.
- Game version and migrate upgrade older slots at validation; a slot from a newer build is rejected, so that guest reloads.
- Timers are slot data (slot.timers, deadlines stamped from the host’s Clock when the effect is applied). The host runtime arms one Clock.after per running timer, fires the handler and removes the timer in one publish, re-arms from the slot after failover, and freezes timers while paused. presence.onChange may return withEffects.
- A game’s device-only state is declared with defineLocalState and read through game.local(def). It lives in an injected KeyValueStore (localStorage with expiry), keyed by room, round and player, and is never replicated.
- Private per-player state: the slot replicates only revisions (privateRev); pieces live in the host’s memory and each owner’s, moved by the bus PrivateChannel (private host to owner, mine owner to host). Pieces are committed before the slot referencing them is published. A mismatching piece re-requests itself on the resync timer. After a failover guests offer their own piece before the state offer; the host adopts only a verified owner’s matching piece, and privateState.recover rebuilds the rest.
