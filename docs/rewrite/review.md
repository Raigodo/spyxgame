# Convenience review

Read to see where config, data and callbacks are scattered today, and what the redesign in [proposal.md](./proposal.md) fixes. Based on reading the code, not on running it; counts are from reading, not a usage scan.

## Config

- **Numbers and names are scattered.** Only `Ms` and `Seconds` knobs are in `AppConfig`, and `timer-inventory.test.ts` checks only those keys. Outside config and docs:
  - Parser limits: `MAX_SDP`, `MAX_BATCH`, `HISTORY_LIMIT`, `BAN_LIMIT`, `MAX_TIMERS`, `MAX_NOTICES`, `MAX_NAME_LENGTH`, `MAX_PRIVATE`, `MAX_LOCAL_LENGTH`.
  - Id length caps: 32, 40, 64, 100 and 128 in different files.
  - UI constants: the room-code regex in `room/page.tsx`, the 4s ICE fetch timeout, `TICK_MS`.
- **Magic strings, declared nowhere together:**
  - Bus channel ids: `room`, `chat`, `presence`, `presence:history`, `presence:bans`, `game:<id>`, `game:<id>:events`, `game:<id>:private`.
  - Firestore paths: `rooms`, `signaling-peers`, `messages`, `election-candidates`, `host/current`.
  - Storage prefixes: `player-profile:`, `host-claim:`, `game-local:`.
  - Wire literals: `__bus`, `__chunk`, `__probe`.
- **"Config" means four things:** `AppConfig` (tuning), `SpyConfig` (game settings), `LobbyConfig` (mode and teams), `RoomState.game.config`.
- **Three places describe the same timer:** `config.ts` comments, `docs/timers.md`, `docs/invariants.md`.
- **Two composition roots.** Each layer's `index.ts` factory has its own `?? new SystemClock()` defaults, on top of `createMultiplayerClient`. The comment about "an explicit `undefined` replaces the default" is a symptom.
- `AppConfig` in kernel lists every layer's sections (bus, presence, game, chat), so a feature's timer edits the lowest layer.

## Data

- **Seven shapes for "a player":** `SignalingPeer`, `RtcPeer`, `PlayerProfile`, `RosterPlayer`, `LobbyPlayer`, `RoomPlayer`, `GamePlayer`. Each layer adds an adapter that re-projects the previous one: `LobbyPlayerView`, `RosterView`, `GameHandle.getPlayers`.
- **Untyped `metadata` bag** carries `playerId`, `readyRound` and `teamId`, read in five places. `restore` replays arbitrary keys and `missingKeys` merges them by name.
- **Per-player data has six homes:** profile metadata, the `presence:history` channel, the private channel, local game state (KV store), the profile cookie, the sessionStorage host claim. No rule says which to use.
- **The slot has 18 fields.** Framework features (away, pause, notices, timers, private revisions, names, teams) are mixed with game state. Each new framework feature edits `Slot`, the `validateSlot` block, `GameHandle` and the docs.
- **Room state and game slot are two channels.** Starting a game is two steps, and pages guard with `if (!state || !config) "Starting game…"`. `round` exists mainly to detect staleness between them. Every registered game gets 2–3 channels even when idle.
- **Pages lack accessors.** The spy page derives `me` by searching `players` though `client.getPlayerId()` exists. `nameOf` is duplicated in both game pages. The spy page calls `crypto.getRandomValues` for the seed. Rejection reasons are free strings mapped to text by hand.

## Orchestration

- **Manual recompute calls:** `reconcile()` from 5 sites, `lifecycle.sync()` from about 9, plus `refreshPlayers`, `refreshPending`, `syncAndBroadcast`. `PlayerPresenceService.onChanged` emits `updated` for every player to simulate a derived value.
- **Hand-rolled `cleanups: Array<() => void>`** in about 6 classes plus loose `unsubscribe*` fields. The teardown-order rule exists because ordering is manual.
- **Ordering documented as an invariant in 6 places:** pong before the guards, restore before reveal, "subscribed first", "branch order is load-bearing", subscribe before join, the duplicate seat watcher.
- **`room-hooks.ts` has 12 hooks**, each wrapping `useClientValue(subscribe, get, server)`, which is the getter plus callback pair written out by hand.

## Structure (from the first review)

- Adding a game touches 5 places across 3 layers (definition, `games.ts`, `lobby-games.ts`, a route page, docs). `shared/presentation` imports `@/spy` and `@/demo-tap`, and they import back (`spy-starter` ↔ `lobby-games`). Framework tests import `demo-tap`.
- `GameSpec`, `CommandDef` and `GameHandle` carry 6 type parameters. Adding private state widened every signature.
- Game pages repeat the header, end, leave and chat shell, and use 6–8 independent `useGameValue` calls that can tear. `GameHandle` has five copies of the slot-memo pattern.
- Validators are hand-written in about 10 places, with differing policies (the status map drops bad entries, others reject the whole message).
- Two replication systems: `PlayerSession` roster/metadata and `RoomBus` state. Lobby ready and team live in profile metadata, which forces the history channel, `restore`, `returning`, `selfRestore`, `isLocalPending` and the restore-before-reveal rule.
- `PlayerReconnectionCoordinator` is dispatcher, moderation, history, restore and status in one class. `MultiplayerClient` is composition root, lifecycle and 50+ public members.

## Robustness gaps outside the core

- `deploy.yml` is invalid YAML (code fences), has no `pnpm check` gate, and uses Node 20 and pnpm 10 where the repo needs Node 22+ and pnpm 11. `verceel.json` is misspelled.
- Identity is asserted, not proven: `playerId` comes from the URL and is visible in roster metadata, and `fromPeerId` in signaling messages is unverified. No Firestore rules file is in the repo. A ban is evaded by opening the invite link without `?playerId`.
- No `error.tsx`: a throw in a game page tears the tree.
- Nothing reports failover time, election outcomes or link failures.
- Every commit broadcasts the whole slot, and `applied` marks are never pruned. Fine for spy, watch it for big boards.
- Hygiene: `LobbySnapshot` looks unused, `app/page.tsx` is a placeholder, `public/*.svg` are Next defaults, a few deep imports bypass barrels.

## Keep unchanged

Correct, and documented as such. Move these, do not redesign them:

- election, failover, reclaim
- bus epoch/rev, exactly-once commands, promotion recovery
- private pieces
- effects as data
- timers in the slot
- the pure-core files (`*-rules.ts`, parsers)
