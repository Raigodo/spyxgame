# Decisions

Read when you wonder why something is built the way it is, or before reversing something. Each entry: the decision, why, and what was rejected. If a decision is reversed, edit it here. Entries marked (inferred) come from the code and older notes, not from a recorded discussion.

## Identity

- **ULID peer ids, fresh per join.** The election picks the smallest id, so ids that sort by creation time make the longest-present peer win. Clock skew can skew this; accepted. One id format everywhere, so a stray generator cannot break the rule.
- **`playerId` is the durable identity, `peerId` is per page load.** Everything about "the same person" (returning, duplicates, bans, game seats) keys on `playerId`.

## Liveness and election

- **WebRTC link death plus Firestore signaling, not Realtime Database.** Improve by measuring (`failover-timeline.test.ts`), then tightening.
- **No heartbeats.** Membership has no liveness. A peer leaves membership only when someone suspects it, through `PeerRemover` (one debug line, per-reason counts).
- **Suspected host is removed only when the 3s window ends without its link returning.** Removal at suspicion time would kill live hosts on a blip.
- **Only confirmed candidates are elected, claimed atomically.** Membership never picks the winner. Cost: one extra write per candidate. Rejected: electing the smallest live member (dead members look live).
- **Ack timeout is vetoed when the data channel is active.** No "fragile" status: real death is caught by connection-state detection.
- **The host probes idle links, guests never do.** A guest inferring things from silence would trigger spurious elections.
- **Tightened timers:** candidate window 5s to 3s, position interval 1.5s. The window stays at 3s because it is also the unstamped-reclaim grace.

## Refresh and ghosts

- **Reclaim by hint, verified atomically.** A per-tab `sessionStorage` hint (stamped on `pagehide`) lets a reloaded host take the seat back at once. Rejected: persistent storage (a new tab or device must start as an ordinary guest).
- **Ghost grace 4s** so a dead host's row leaves sooner; a slower reload shows as a new join. Rejected: skipping the ghost only for a replaced host (ordering race).
- **Newly promoted host prunes roster entries with no membership doc**, and `WebRtcService.removePeer` cleans up locally, because the membership snapshot may never fire.

## Presence and bus

- **Presence split** into `PresenceBook` (data), `DuplicateView`, `DuplicateArbiter`; the coordinator only dispatches and keeps two orders (see [presence](./concepts/presence.md)). Pinned by `presence-scenarios.test.ts`.
- **History and bans are replicated state channels**, not host memory, so they survive host changes.
- **Recovery waits for linked-or-linking peers for 2s, then only active links**, so a dead member cannot hold recovery for the 10s cap.
- **Signals are opaque to signaling.** The RTC layer owns `RtcSignal` and validates every incoming one. ICE candidates go in batches.

## Client and API

- **A client value is a `Store<T>` behind one getter and one `on...` callback**, stable until it really changes, so it backs `useSyncExternalStore` directly.
- **`use*` is reserved for hooks.** "Session" means `SignalingSession` or `PlayerSession` only.
- **One `LobbyModule`, mode as data.** Rejected: a module per mode.
- **One `{definition, route}` entry per game**; duplicates or bad routes throw at load.
- **`MultiplayerClient.getDebugState()` is exempt from the getter-plus-callback rule**; `window.__room()` exists in non-production builds only.

## Games framework

- **Player names live in the replicated slot.** Rejected: cookies (they hold only the local player's own nickname, per browser), and local memory (breaks for refreshed tabs and late joiners).
- **Away is slot data written only by the host runtime; local timers only debounce.** A failover re-derives it. Rejected: host-memory presence (lost on failover).
- **Pause is a slot flag enforced by the generic command gate**, not a per-game check.
- **Reducers return effects as plain data** (`emit`, `end`, timers). Rejected: reducers calling the runtime (not pure, not replayable by a new host).
- **Notices reuse the game's `events` validators.** No new generic parameter.
- **Timers are slot data with epoch deadlines from the host's clock; guests only display.** Skew affects countdowns, not logic. Frozen while paused. Rejected: timeouts in pages, and per-peer clock-offset estimation (add only if skew hurts).
- **Local state is a separate `defineLocalState`, not a spec field.** A spec field would have added another generic everywhere. Storage goes through the `KeyValueStore` port, not `window.localStorage` in pages.
- **Private pieces never enter the slot.** Rejected: cryptographic hiding (large cost, and the host is a browser anyway). Pieces are committed before the slot referencing them is published.
- **Game state is versioned** (`version`, `migrate`); a newer slot is rejected so that guest reloads instead of misreading.
- **Spy resolves phases through one pure `settle`**; reducers only record the action. Away players are skipped and not waited for.

## Firestore cost

- **New docs carry `expiresAt` from the injected Clock** with TTL policies on `rooms`, `signaling-peers`, `messages`, `election-candidates`, `host`. Transients 1h, long-lived 7d, no heartbeat refresh. It saves storage, not reads.
- **ICE batching** (300ms window, 20 max) cuts signal docs. Unmeasured on real networks.

## Logging and errors

- Per-scope levels via `NEXT_PUBLIC_LOG_SCOPES`. `listenerFailure` for emitter errors, `logFailure` for fire-and-forget promises, throttled warnings for dropped input.
- `leaveRoom` runs every remote step best-effort; local state always resets.
- Stateful classes expose read-only `inspect()` (ids and counters only).
