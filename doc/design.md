Design: browser board-game framework (P2P over WebRTC)

Goal: a framework where any board game is one typed definition (defineGame) plus a page. Networking, lobby, chat and recovery are never touched per game.

Priorities, in order: (1) resilience, (2) readable code that is cheap to change, (3) testable and modular, (4) minimal Firestore usage, (5) minimal token use in AI chats.

If this document and the code disagree on a detail, the code wins. If they disagree on intent, ask.

1. Topology
   Players talk peer to peer over WebRTC data channels (ordered, reliable, label "data").
   Star topology: the host connects to every guest. Guests talk only to the host. The host relays broadcasts and direct messages and stamps the verified sender.
   Firestore is only for signaling: room membership, per-peer signal inboxes (offer, answer, ICE), the host document, election candidates.
   No heartbeats, no polling. Membership has no liveness; a dead peer is removed only when someone suspects it.
   The host is elected, not fixed. State is host-owned but replicated, so any guest can become host and continue.
2. Layers (bottom to top; no React hooks below presentation)

kernel: Emitter, Clock (after/every return cancel functions), IdGenerator (ULID), Logger, KeyValueStore, PageLifecycle, Countdown, shortId, config (one typed object, one section per layer).

infrastructure/signaling: ports (RoomMembershipPort, SignalInboxPort, HostElectionPort), Firestore adapters, SignalingSession (join/leave, peer tracking, mailbox, ack tracker), HostElectionService (suspicion, candidate window, turns, claimHost, transferHost). Pure: election-order, peer-diff.

infrastructure/webrtc: ports (RtcConnectionProvider, RtcPeerConnectionPort, RtcDataChannelPort), browser adapters, WebRtcService (join/leave shell, host-change sequence, handoff), RtcHostRole, HostReclaimController, RtcSignalRouter, RtcPeerRegistry, RtcPeerLinkFactory, RtcLinkNegotiator (one link: offer/answer/ICE), ActiveRtcConnection, RtcReconnectionManager (offer watches, reconnect), ChunkedMessenger. Pure: chunking (split, validate, reassemble), link-policy.

infrastructure/player: PlayerSession (star relay, roster, verified-sender stamping), PlayerDirectory, HostClaimStore (refresh hint), PlayerProfileStore (nickname), envelope-parser, roster-diff.

application/messaging: RoomBus with StateChannel, EventChannel, CommandQueue, wire parsing, bus-rules, and a transport adapter over PlayerSession.

application/presence: PlayerReconnectionCoordinator (status, returning-player history, duplicate arbitration, kick, hello), PlayerPresenceService (roster read-model), DepartureGhosts, duplicate-rules.

application/lobby (one `LobbyModule`, rules in `lobby-rules.ts`), chat, game (defineGame, GameRuntime, GameHandle, GameHostRuntime), room (RoomStateService, MultiplayerClient facade, createMultiplayerClient composition root).

Client helpers: HostSeatKeeper (refresh hint rules), ClientGameBackend (what GameHandle talks to).

presentation: RoomProvider, hooks (one useSyncExternalStore per getter), RoomNavigator, ChatPanel, pages. Pages are the regression boundary.

3. Messaging model (the bus)
   Three kinds: state (host-owned replicated value), command (pure reducer run on whichever peer is host), event (ephemeral, delivered locally to the sender too).
   State is versioned by (epoch, rev). Guests accept only newer versions from the current host.
   Commands are exactly-once per (sender, seq) via replicated high-water marks. Senders queue unacked commands (30s TTL) and re-send on link-up or host change.
   Each game has its own state channel game:<id>. Room state is separate.
   Promotion recovery: a new host asks for copies, guests offer theirs, host adopts the newest, waits (3s sliding window, 10s cap), then publishes with epoch+1. Guests re-request snapshots every 3s while unsynced. Status is syncing | ready.
   All channels are registered before bus.start().
   All network input is parsed at the boundary (wire.ts, envelope-parser, per-channel validators).
4. Invariants (never break) and why
   Only the current host's death may be inferred from a closed link or missed offer. Reporting anyone else removes a live peer from membership and triggers spurious elections.
   reportSuspectedDeath is destructive: it deletes the peer from membership immediately.
   Never close links on a host change. The other side reads a closed link as host death. Stale guest-to-guest links are harmless.
   Offer watches are cleared on every host change and re-check that the peer is still host when they fire.
   Host-change events can repeat for the same host and must not discard synced state.
   playerId is durable; peerId is fresh per join and never reused (a fresh session stack per join).
   Network input is untrusted. Only the host-verified from is trusted; the host relays the stamped envelope.
   Reducers are pure functions of (state, payload), so a new host can continue from replicated state.
   A pong travels guest to host, so it is handled before host-only guards.
   A ping before the link is active is silently dropped and makes a live tab look like a ghost. After promotion, arbitration waits for links (8s cap).
   Sends silently drop when a link is not active; broadcast is exception-safe per peer.
   Prefer self-healing repeats (periodic snapshot request, hello, offer-on-link-up) over more one-shot messages.
   Teardown order: client wiring, bus, presence, session. leaveRoom is idempotent.
   When disposing a link, remove it from the registry first, because closing fires "connection died".
   Getters on MultiplayerClient return stable references between changes.
   Firestore: no new reads or polling without a clear need.
5. Conventions
   Everything touching the outside world is injected as a port. No direct setTimeout, Date.now, crypto, window, document, sessionStorage or console in infrastructure or application.
   Classes take one deps object and only their own config section.
   Emitter with a single payload; listeners are isolated (one throwing never stops the others).
   Decision logic lives in pure functions in their own files; classes stay thin shells.
   Public client API: plain getters, on... callbacks, intent methods returning typed results. A getter has one matching callback that fires only on real change. Intents do not throw for expected failures.
   Names: kebab-case files with role suffix (-port, -adapter, -service, -store), one exported class per file.
   A derived value the client exposes (status, phase, players, lobby, pending) is a kernel `Store<T>` behind the getter and `on…` pair: notifies only when its equality check says the value changed, and keeps the old reference otherwise. Hooks go through `useClientValue`.
6. Decision log
   ULID peer ids: the election picks the smallest live peer id, so ids that sort by creation time make the longest-present player win. Clock skew between clients can skew this; accepted.
   One id format everywhere (no UUID generator), so the ordering rule cannot be broken by a stray generator.
   Host reclaim: a per-tab sessionStorage hint names the old peer. pagehide stamps it, so a reload within 15s knows the old page is gone, removes it from membership itself, and claims the seat immediately. Without the stamp, the slow safe path runs (wait for the old peer to leave membership; never claim while it is present). The hint is written both right after join and on host change, because a room creator's host event fires during join, before handlers exist.
   Reclaim is a hint, verified against Firestore by an atomic claimHostIf.
   Departed players show as local "reconnecting" ghost rows for 10s. Local to each peer, not replicated (no new network state). Kick sends a farewell so no ghost lingers. A player never sees a row for their own previous incarnation. Ghost rows count as players (all-ready, min/max, game participants); intended during a refresh.
   A newly promoted host prunes roster entries whose membership doc is gone, and WebRtcService.removePeer cleans up locally, because the membership snapshot may never fire (cause of undeletable ghosts).
   Chunked messages: envelopes claiming __chunk are validated (bounds, 256 chunks max); malformed ones are dropped, not passed through.
   PlayerSession validates every envelope and filters invalid roster profiles.
   Unified Emitter over hand-rolled handler sets; error isolation rethrows in a microtask.
   Composition: createMultiplayerClient builds clock, ids, logger, config once; the client receives a createSession() function, not a session.
   Page events go through a PageLifecycle port, not window.
   Logging: per-scope levels via `NEXT_PUBLIC_LOG_SCOPES="bus:debug,webrtc:warn"`, matched by any scope segment (last matching segment wins). Emitter listener errors in RtcPeerRegistry, PlayerPresenceService and PlayerReconnectionCoordinator are logged under the owner's scope (`listenerFailure`) instead of rethrown in a microtask; the other emitters move over when their classes are split. Dropped invalid input (bus wire, chunks) warns with `{from, kind}`, throttled per sender (5s, a kernel default rather than config, with a `suppressed` count on the next warning); `PlayerSession`'s malformed-envelope warning joins once it has an injected Clock. Command rejections log at info on the host and on the sender (from the ack). Epoch/rev in logs wait for `inspect()`.
   Inspectability: stateful classes expose a read-only `inspect()` returning plain JSON (bus, channels, election, registry, reconnection manager, signaling session, WebRtcService, PlayerSession, presence, coordinator). `MultiplayerClient.getDebugState()` composes them. It is a diagnostic snapshot, exempt from the "a getter has one callback" rule: computed on demand, no callback, nothing in the app reads it, and the shape is not a stable API. State values and profile metadata are left out of dumps (keys, ids and counters only). `window.__room()` is installed by the RoomProvider in non-production builds only.
   Test harness: `RoomHarness` (src/shared/testing) runs N real MultiplayerClients over fake Firestore ports (one shared `FakeFirestoreState`, one `FakePortLife` per tab), a fake RTC network and one `FakeClock` (each tab gets a `ScopedClock` so `kill()` cancels its timers). `kill(detectionMs)` simulates a dead tab (no leave, no pagehide) and `refresh()` a page reload. Approximations are documented on the class (snapshots fire before the causing write resolves, link opens when the answer is applied, one fake ICE candidate per description). It uses real `setTimeout(0)` to let async work finish, so tests using it must not use `vi.useFakeTimers()`. `firestore.stats` counts reads, writes and deletes per call (per document for lists and inbox messages) so cost changes can be asserted.
   Liveness: staying on the current approach (WebRTC link death plus Firestore signaling), not moving membership to Realtime Database. Improvement is by measuring and tightening: failover timeline tests first (`milestones.ts`, `failover-timeline.test.ts`), then a timer inventory, then smaller timers, then a single removal pipeline and verify-before-delete for suspected deaths.
   Timers: every timer in `config.ts` is listed in design.md section 10 with its false-positive and cost-if-wrong. A test requires new timers to be listed and keeps three relations true (command TTL above the failover budget, reveal safety above ping timeout, recovery cap above its window). Timers tagged destructive (`ackTimeoutMs`, `offerTimeoutMs`, `pingTimeoutMs`, `linkWaitMs`) do not shrink until verify-before-delete exists.
   Timers tightened (config only): candidate window 5s to 3s, position interval 5s to 2s. The window stays at 3s because it is also the unstamped-reclaim grace for a refreshed host; `reclaim.test.ts` covers stamped and unstamped reclaim. Destructive timers are untouched. A separate reclaim delay is the next lever if the window needs to shrink further.
   Test timing: the harness waits with `setImmediate` (`next-macrotask.ts`), not `setTimeout(0)`, because timers have about 15ms granularity on Windows and `settle()` runs hundreds of rounds per scenario. The harness keeps the real timer config so timeline numbers stay meaningful.
   Naming: `use*` is reserved for React hooks (`MultiplayerClient.useGame` became `getGame`). The duplicate-tab event is `onSuperseded` at every level, so "session" only means `SignalingSession` or `PlayerSession`. The glossary is design.md section 11. Renaming those two classes is deferred.
   Subscriptions: every `on...` returns the `Unsubscribe` of its own emitter registration, never `clear()`, so one consumer leaving cannot remove another. `clear()` is only for owner teardown (`stop()`, `dispose()`).
   Leaving: `SignalingSession.leaveRoom` runs every remote step best-effort (`bestEffort`: log, never throw). Local cleanup and the membership removal always run, the removal last, and local state is always reset, so a failed leave cannot leave a ghost behind because of an earlier step or block a rejoin. Fire-and-forget promises use `logFailure`; `catch(() => {})` is not used.
   Guards: `isRecord` (plain object, not array) and `isInt` live only in `kernel/guards.ts`; a test fails if another source file defines them. Network validators use them instead of inline `typeof x === "object"` checks, so arrays are never accepted as records.
   Clock everywhere: `PlayerSession` takes the Clock for profile `updatedAt` and for the throttled malformed-envelope warning, so the last `Date.now` exception outside `SystemClock` is gone. The cookie adapter URI-encodes names as well as values; old unencoded profile cookies are orphaned and expire within 24h.
   Reconnect timer in RtcReconnectionManager.reconnectAsGuest is untracked.
   WebRtcService split: host role (`RtcHostRole`), reclaim (`HostReclaimController`) and signal dispatch (`RtcSignalRouter`) are separate classes; `WebRtcService` keeps join/leave and the host-change sequence, whose order is load-bearing (reclaim check, clear offer watches, set role, emit, watch for offer). The guest reconnect timer was already tracked (`guestTimers`, cancelled in `stop()`). Behavior is unchanged; `host-reclaim-controller.test.ts` and `rtc-signal-router.test.ts` pin the moved logic.
   Games: one `{ definition, route }` entry per game (`createGameRegistry`, pure), so a game cannot be registered without a route. A duplicate id or malformed route throws at module load. `RoomNavigator` warns in non-production when the room runs a game this client has no route for, instead of ignoring it silently.
   Firestore TTL (`expiresAt`) is stamped on new docs only. Docs created before it never expire. A live session older than `roomRetentionMs` (7d) loses its membership/host docs.
   Firestore retention: new docs carry an `expiresAt` Timestamp stamped from the injected Clock (`expiry.ts`); TTL policies on `rooms`, `signaling-peers`, `messages`, `election-candidates` and `host` delete them lazily. Transient docs (signals, candidates) live 1h, long-lived ones (room, membership, host) 7d, with no heartbeat refresh, so a session older than 7d is the accepted ceiling. A room doc's subcollections are not cascaded, so every collection has its own policy. Saves storage, not reads.
   Lobby: one `LobbyModule` with the mode as data (`LobbyConfig`) and pure rules in `lobby-rules.ts`; the two per-mode services were removed (80% duplicated, and their team-listing methods were unused). Roster and lobby-info change detection use the kernel `structurallyEqual` over the whole player object including metadata, instead of a hand-listed key, so a new field can never be silently ignored. Cost: a metadata change in any key now fires a roster update.
   Client split, part 1: `HostSeatKeeper` owns the refresh-hint rules (remember only while host, stamp on pagehide, forget on a deliberate leave), and `ClientGameBackend` is what `GameHandle` talks to, with its own slot/event emitters (now using the scoped listener-error handler). The client reads its live parts through a small deps object. The duplicate `rememberHostSeat` call stays until wiring happens before join (part 2).
7. Known weak spots
   Failover takes about 5 to 8s (detection, 3s candidate window, 2s per candidate position, link setup, up to 3s recovery). The 3s window doubles as the old host's grace period for reclaim when no pagehide stamp exists (about 2s after detection). `failover-timeline.test.ts` prints the measured fake-time milestones for a dead host and a dead guest; read those before changing any timer.
   Election writes with an unconditional setDoc (last writer wins); only reclaim and handoff use the transaction. A small race remains.
   Reclaim works for a refresh of the same tab only. A refreshed host's own ready and team are not restored (history is host memory only and can be lost across host changes).
   Duplicate arbitration handles one pair per playerId and cannot tell which of two live duplicates is older.
   A copy fresher than the one the new host adopted, arriving after it published, is dropped. Applied marks are never pruned.
   Chunk length counts UTF-16 units, not bytes.
   Direct chat messages are readable by the host (star relay). Kicked players can rejoin (no ban).
   Stale guest-to-guest links accumulate (small).
   Reconnect timer in RtcReconnectionManager.reconnectAsGuest is untracked.
   UI buttons are not disabled while syncing.
   Dev only: React StrictMode needs the provider's one-tick join delay; Fast Refresh calls leave() and forgets the host hint (test reclaim in a production build).
   RoomNavigator compares pathname to /room/${roomId}${sub}; room codes are restricted to [A-Za-z0-9_-]{3,32}.
   Test coverage is partial: pure cores, a few classes and a handful of multi-peer smoke scenarios (`room-harness.test.ts`). Refresh, duplicate-tab and election-race scenarios are not written yet.
8. How to extend

Add a game: write one defineGame definition (id, modes, min/max players, validateConfig, validateState, initialState, commands with pure reduce, optional events and onLateJoin); add one `{ definition, route }` entry in `presentation/room/games.ts`; add a page at that route using the game handle hooks. Never touch networking.

Add a port: define the interface next to its layer (ports/), write the browser or Firestore adapter in adapters/, inject it through the owning class's deps object, wire the default in the layer's index.ts factory and the override in createMultiplayerClient, and add a fake for tests.

Add a presence event: extend the PresenceEvent union and its parser in the coordinator, handle it in handleEvent, expose an on... if consumers need it.

Add a timing or limit: add it to the matching config section with a comment, read it from the injected config.

Add host-only behavior: use hostOnly: true commands; host-side logic must work from replicated state alone.

9. Progress

Done: strict TS, Vitest harness (one placeholder test), kernel, ports and adapters, composition root, dependency injection in all layers, pure cores, reclaim fix, ghost rows, cleanup pass, PageLifecycle port.

Next: split big classes one per step, bottom-up: signaling session and election, RoomBus, presence coordinator, MultiplayerClient (subscribe before join). Then conventions doc. Then leftover fixes and public API cleanup (remove unused API, atomic game view, isHost on players; `getGame` rename done). Tests last.

10. Timer inventory

Every timer in `config.ts`: what it protects against, what a wrong firing costs, and whether it can shrink. "Destructive" means a wrong firing removes a live peer. Verify any change against `failover-timeline.test.ts`.

| Timer                         | Default | Protects against                                                                                                                                  | If too short                                                                                                                                              | Shrink?                                                                                                   |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `candidateCollectionWindowMs` | 3s      | Guests noticing a dead host at different moments, so every candidate is in the list before turns are assigned. Also the old host's reclaim grace. | A late detector is missing from the list; two peers may both elect (last writer wins).                                                                    | Done (3s). Going lower shrinks the unstamped reclaim grace; split reclaim from the election window first. |
| `positionIntervalMs`          | 2s      | Candidate 0 being dead or slow. Position n waits n intervals.                                                                                     | Candidate 1 elects before it sees candidate 0's write. A host-document change cancels pending turns, so only write plus snapshot latency must be covered. | Done (2s).                                                                                                |
| `ackTimeoutMs`                | 15s     | A peer in membership that never reads its signal inbox.                                                                                           | **Destructive**: deletes a slow-but-live peer (throttled background tab).                                                                                 | Not before verify-before-delete exists.                                                                   |
| `messageRetentionMs`          | 1h      | Signal messages nobody consumed (recipient died) piling up. Firestore TTL, lazy (hours).                                                          | A pending signal is deleted before it is read; the sender's ack timeout already handles that case.                                                        | Leave. Must stay above `ackTimeoutMs` (tested).                                                           |
| `candidateRetentionMs`        | 1h      | Election candidate docs left behind.                                                                                                              | A candidate disappears mid-election.                                                                                                                      | Leave. Must stay above the election budget (tested).                                                      |
| `roomRetentionMs`             | 7d      | Abandoned rooms, memberships and host docs piling up.                                                                                             | **Destructive**: a live session longer than this loses its membership or host doc and triggers a re-election.                                             | Leave. Raise it if sessions can run for days.                                                             |
| `offerTimeoutMs`              | 5s      | A host that never sends an offer.                                                                                                                 | **Destructive**: suspects a live host on slow ICE or slow join.                                                                                           | No. Highest false-positive risk.                                                                          |
| `reconnectTimeoutMs`          | 5s      | A guest waiting forever for a re-offer after its link died.                                                                                       | Drops the local entry early. Low harm: an arriving offer recreates it.                                                                                    | Yes, but low value.                                                                                       |
| `reclaimWindowMs`             | 10s     | A refreshed host retrying `claimHost` while its old peer still looks present.                                                                     | The seat goes to someone else. Not harmful, the host just moves.                                                                                          | With the candidate window (they overlap).                                                                 |
| `chunkBufferTtlMs`            | 30s     | Partial messages that never complete.                                                                                                             | Large messages on slow links are dropped.                                                                                                                 | Leave. Not liveness.                                                                                      |
| `commandTtlMs`                | 30s     | Commands waiting for an ack forever.                                                                                                              | Commands expire during a failover and are lost.                                                                                                           | Only while it stays above the failover budget (tested).                                                   |
| `recoveryWindowMs`            | 3s      | A new host publishing before slow guests offered their copies.                                                                                    | A fresher copy arrives after publishing and is dropped (known weak spot).                                                                                 | No.                                                                                                       |
| `recoveryMaxMs`               | 10s     | Recovery waiting forever for an unreachable guest.                                                                                                | Same as above, for guests with slow links.                                                                                                                | Not below `recoveryWindowMs` (tested).                                                                    |
| `resyncIntervalMs`            | 3s      | A dropped snapshot leaving a guest unsynced. Repeats only while unsynced.                                                                         | Extra snapshot requests, only while unsynced.                                                                                                             | Yes, cheap.                                                                                               |
| `pingTimeoutMs`               | 2s      | A duplicate-session check hanging. No pong means ghost.                                                                                           | **Destructive**: removes a live old tab that is slow to answer.                                                                                           | No.                                                                                                       |
| `duplicateRevealTimeoutMs`    | 4s      | A hidden newcomer staying hidden after a dropped resolution message.                                                                              | Reveals before arbitration ends, a flicker.                                                                                                               | Must stay above `pingTimeoutMs` (tested).                                                                 |
| `helloIntervalMs`             | 3s      | The host's one-time status broadcast being dropped. Repeats only while pending.                                                                   | Extra hello messages while pending.                                                                                                                       | Yes, cheap.                                                                                               |
| `linkWaitMs`                  | 8s      | Pinging before data-channel links are active (dropped ping, live tab looks like a ghost).                                                         | Arbitration starts before links are up, so live tabs may be removed.                                                                                      | No. Cap on link setup.                                                                                    |
| `departureGraceMs`            | 10s     | A refreshing player's row vanishing and returning.                                                                                                | Row disappears during a slow reload, then reappears as a join.                                                                                            | Yes, down to a typical reload time (about 3 to 5s).                                                       |
| `hostClaimMaxAgeMs`           | 15s     | A stale pagehide stamp being trusted.                                                                                                             | A slow reload falls back to the slow reclaim path.                                                                                                        | Leave.                                                                                                    |
| `cookieMaxAgeSeconds`         | 24h     | Abandoned local profiles piling up.                                                                                                               | Nickname forgotten sooner.                                                                                                                                | Leave. Not liveness.                                                                                      |

Relations that must hold (checked in `timer-inventory.test.ts`):

- `commandTtlMs` exceeds the failover budget (candidate window + two position intervals + `recoveryMaxMs`), or commands sent during a failover expire.
- `duplicateRevealTimeoutMs` exceeds `pingTimeoutMs`.
- `recoveryMaxMs` is at least `recoveryWindowMs`.
- `messageRetentionMs` exceeds `ackTimeoutMs`; `candidateRetentionMs` exceeds the election budget; `roomRetentionMs` exceeds a day (TTL deletion lag).

## 11. Glossary

- **Member / membership**: a peer's document in Firestore `signaling-peers`. Says nothing about liveness.
- **Peer** (`peerId`, ULID): one joined page load. Fresh per join, never reused. Used for links, elections and verified senders.
- **Player** (`playerId`): the durable identity of a person across refreshes and reconnects. Lives in profile metadata.
- **Link**: the WebRTC data channel to one peer (`RtcPeerRegistry` entry), with status connecting / active / reconnecting.
- **Signaling session** (`SignalingSession`): Firestore side of a join: membership, signal inboxes, host election.
- **Player session** (`PlayerSession`): the roster and star relay on top of the RTC links.
- **Join / leave**: client-level (`MultiplayerClient.join/leave`, `PlayerSession.join/leave`). `joinRoom/leaveRoom` belong to the lower layers (`SignalingSession`, `WebRtcService`) and mean the same thing at their level.
- **Superseded**: this tab lost duplicate-tab arbitration and was removed (`onSuperseded`, status `superseded`). **Kicked**: removed by the host on purpose.
- **Ghost**: a departed player's local "reconnecting" row, kept for the grace period. Also used for a dead duplicate tab that arbitration removes.
- **Host seat**: the host document naming a peer. **Reclaim**: a refreshed host taking the seat back with a new peer id.
- **Naming rule**: `use*` is for React hooks only. Non-hook accessors are `get*`.
