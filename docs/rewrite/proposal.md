# Architecture proposal

Read before restructuring the codebase. It proposes a new architecture; problems it answers are in [review.md](./review.md), the current state is in [architecture-map.md](./architecture-map.md). Status: proposal, nothing applied. A full rewrite and breaking changes are acceptable, and tests may be dropped.

## Goal

Highly readable, a new feature slots in with ease, changing an existing feature is not painful, and the same rules hold in every layer.

## Principles

1. **State is stores, moments are events.** Anything readable is a `Store<T>`; derived values are derived stores. Events are only for things that happened once (kicked, superseded, notice, chat message).
2. **Every slice has the same anatomy** (below).
3. **Numbers and names live only in `config.ts` and `names.ts`.** Parsers read their limits from config.
4. **Data has named kinds** (below), so "where does X live?" has one answer.
5. **Rules contain no I/O. Flows contain no decisions and no literals.**
6. **One composition root.** Slices take required deps and have no defaults.
7. **One public API shape per slice:** `{ state, actions, events }`.

## Layout

```
src/
  kernel/    ports, Store, derived, Scope, Emitter, schema helper, defineConfig
  slices/
    signaling/ link/ relay/ bus/            infrastructure tiers
    roster/ moderation/ lobby/ chat/        room features
    game/ room/                             framework and facade
  games/     index.ts (GameModule[]), spy/, demo-tap/
  ui/        RoomProvider, useStore, useGame, GameShell, error boundary
  app/       routes only
  testing/   fakes, RoomHarness (optional, see Tests)
  compose.ts the only place with defaults (real clock, logger, adapters)
```

Tier order: signaling → link → relay → bus → roster → moderation/lobby/chat → game → room. A slice depends only on lower tiers (convention, no lint rule).

## Slice anatomy

```
slices/<name>/
  config.ts   tuning knobs and limits, with descriptors
  names.ts    channel ids, storage keys, wire literals
  model.ts    types and parsers (schema helper)
  state.ts    the data: Store(s) and selectors, nothing else
  rules.ts    pure operations (data in, data or decision out)
  flow.ts     orchestrator: scope.on(...), read state, call rules, write state, call ports
  ports.ts    interfaces to the outside world
  adapters/   real implementations
  fakes.ts    test fakes
  ui/         React components and hooks for this slice
  index.ts    public API: { state, actions, events }
  README.md   at most 40 lines: Purpose, Data, Config, Operations, Events, Invariants
```

"No React hooks below presentation" becomes **"no React outside `slice/ui/`"**. `chat/ui/ChatPanel.tsx` sits next to chat. Everything about a feature is in one folder; kick and ban (six places today) become `moderation/`.

## Data kinds

| Kind              | Mechanism                                       | Examples                            |
| ----------------- | ----------------------------------------------- | ----------------------------------- |
| Shared durable    | bus state channel                               | room, roster facts, bans, game slot |
| Per-player secret | private channel                                 | spy pieces                          |
| Moment            | event channel, or an `emit` notice              | chat, emote                         |
| Device            | `KeyValueStore` scope: tab, profile, game-local | host claim, nickname, notes         |
| Derived           | derived `Store`                                 | players, status, phase              |
| Infra internal    | slice-private state                             | links, candidates, command queue    |

## The redesigns

**R1. Kernel gets `derived` and `Scope`.**

- `derived([a, b], fn)` is a read-only store. `Scope` is a LIFO disposable with `scope.on(emitter, fn)` and `scope.child()`.
- Removes `refreshPlayers`, `refreshPending`, `lifecycle.sync`, the presence "emit updated for everyone" loop and the 6 `cleanups` bags. Teardown order is reverse construction order, so the manual rule goes away. Event-order invariants shrink to the cases that really are about events.

**R2. One player model.**

- Core types: `Member` (peerId, link status, joinedAt) and `Player` (playerId, nickname, typed facts).
- `PlayerProfile` shrinks to identity. Nickname, `readyRound` and `teamId` move to a **`roster` state channel keyed by `playerId`**; commands are authorized through the existing `resolveSender`.
- `relay` keeps the star relay and verified sender; the host publishes the peerId→playerId binding into the roster channel.
- Connection status moves from `status` events plus `hello` into a host-published state channel that self-heals through bus resync.
- One `players` derived store replaces the seven shapes and the three adapter classes; lobby, game and UI project from it with selectors.
- Deletes the history channel, `restore`, `selfRestore`, `isLocalPending` and the restore-before-reveal rule. A ghost is a roster entry with no live peer until the grace expires. `returning` means "playerId already has an entry".

**R3. One `room` channel containing the game slot.**

- `room/startGame` creates the slot atomically in its reducer (deterministic from settings, participants, teams and frozen names).
- Removes "in-game but no slot", the cross-channel `round` check, the create/clear branch of `reconcile`, and per-game channel triplets: one `room` channel, one `game-events` channel, one `game-private` channel for all games.
- Committing private pieces inside the reducer stays as the one documented exception to "reducers are pure".

**R4. Game framework as slot features.**

- A slot is `{ meta, features, state }`. Each feature (presence/away/pause, timers, notices, private, end) is a module `{ key, initial, parse, apply }`; `validateSlot` loops over them. `createRuntime` becomes a feature list.
- `defineGame<GameTypes>` takes one bundle instead of six generics.
- The framework supplies a per-round `seed` (spy's `begin` no longer needs `crypto` in a page). Rejection reasons are a typed union per game.
- Renames: a game's "config" becomes **settings**, `LobbyConfig` becomes `LobbySetup`, so "config" means tuning only.
- `GameModule = { definition, label, route, Starter, Page }`. `games/index.ts` is the only registry; a game route file is one re-export.

**R5. Config as data.**

- `defineConfig("link", { offerTimeoutMs: timer(12_000, { protects, ifTooShort, destructive }), maxSdpChars: limit(100_000), … })`.
- `compose.ts` assembles per-slice configs. `pnpm docs:config` generates `docs/config.md`, replacing `timers.md` and the config comments.
- Relations (`commandTtl > failover budget`, and the rest of today's inventory relations) live in one `relations.ts`, evaluated by one generic check.
- `names.ts` per slice holds ids and keys. Kernel keeps only `defineConfig` and types, so no layer sections remain in the lowest layer.

**R6. Schema helper in kernel.**

- `s.object / s.record / s.list` infer types and make policy explicit: `onInvalid: "reject" | "drop"`. Parsers move to each slice's `model.ts` and read limits from config.

**R7. One API shape, one hook.**

- `client.status`, `client.room`, `client.roster`, `client.lobby`, `client.chat`, `client.moderation`, `client.game(def)`; each has `state` (stores), `actions` (typed results, never throw) and `events`.
- `useStore(store)` replaces about 10 of the 12 hooks. `useGame(def)` returns one atomic snapshot (`state, settings, me, role, players, away, paused, notices, timers`) plus `send`, replacing the 8 `useGameValue` calls and the 5 slot-memo copies. `GameShell` replaces duplicated page headers; the lobby page splits into the lobby slice's `ui/`.

## Carried over

- CI workflow (Node 22, pnpm 11, `pnpm check`), deploy gated on it, fix `deploy.yml` YAML and rename `verceel.json`.
- `error.tsx` under `app/room/[roomId]`, so provider and connection survive a page throw.
- `Telemetry` port with a no-op default: failover duration, election outcome, link death reason, "reconcile did not settle". Counters only.
- Threat-model doc for identity. Friends-only: document ban as soft. Public: Firebase anonymous auth plus rules binding peer docs and `fromPeerId` to the uid.
- Open question, unchanged: a thin WebSocket signaling server would retire election, ack, reclaim and ghost timers. Revisit only if telemetry shows failover is too slow or flaky.

## Tests

Tests are not a constraint: delete any that pin the old structure.

- Pure `rules` and parser tests move with their files and are cheap to keep.
- `RoomHarness` and the fakes are the payoff of the ports design. Recommended to keep, adapting them to the new slices. Scenario tests (`presence-scenarios`, `reclaim`, `failover-timeline`, `election-speed`) double as a behavior spec of the algorithms listed under "keep unchanged" in [review.md](./review.md). Rewrite them once the new slices exist, when asked.
- If all tests go, `pnpm check` and the pre-commit hook fail on "no test files". Set `passWithNoTests` in `vitest.config.ts`, or keep one harness smoke test.
- Docs that read tests (`timers.md` ↔ `timer-inventory.test.ts`) go away with R5.

## Migration order

Without a test net, run a short manual checklist after each step: two tabs join, chat, ready, start spy, refresh a guest, refresh the host, kill the host tab.

1. CI and `error.tsx`.
2. **Mechanical re-slice:** `git mv` into slices, add per-slice `README.md`, `config.ts`, `names.ts`, and move literals out. No logic changes.
3. Kernel: `derived`, `Scope`, `defineConfig`, schema helper, config doc generation.
4. R1 in `room` and `roster` (replace `refresh*` and `sync`, introduce `Scope`).
5. R2 (roster channel, one player model), then the moderation split.
6. R3 (merged room channel).
7. R4 (slot features, `GameModule`, renames).
8. R7 (client API, `useStore`, `useGame`, `GameShell`).
9. R6 gradually, as parsers are touched.

Steps 2–3 give navigability at low risk. Steps 5–6 change behavior the old scenario tests pinned and are the real risk: spike them first.

## Decisions (defaults in bold)

1. Roster facts in a bus channel instead of the metadata bag: **yes**.
2. Merge room and game slot into one channel: **yes**.
3. UI inside slices (`slice/ui/`): **yes**.
4. Rename game "config" to "settings" and `LobbyConfig` to `LobbySetup`: **yes**.
5. Host-published connection status as a state channel: **yes**.
6. Keep `RoomHarness` and fakes, drop the rest of the tests for now: **yes**.

## Unverified

- Nothing has been run or typechecked.
- R2 and R3 depend on details not traced end to end: how a new host re-verifies peer bindings, and slot creation needing roster names at start. Both look feasible; confirm in a spike.
