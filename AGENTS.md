# AGENTS.md

Instructions for AI agents working in this repository. Read this first, then the doc page for the layer you are changing.

## What this is

A browser board-game framework: players connect peer to peer over WebRTC, Firestore is used only for signaling. A new game is one `defineGame` definition plus a page. Start with `docs/README.md` (index) and `docs/architecture/overview.md`.

## Docs

Code wins on detail, docs win on intent. If they disagree, say so and fix the doc in the same change.

| Touching                                     | Read first                                                      |
| -------------------------------------------- | --------------------------------------------------------------- |
| Anything                                     | `docs/architecture/overview.md`, `docs/reference/invariants.md` |
| Stores, Scope, schema, config, ports         | `docs/architecture/kernel.md`                                   |
| Signaling, links, election, relay            | `docs/architecture/transport.md`                                |
| Replicated state, failover recovery          | `docs/architecture/bus.md`                                      |
| Players, names, duplicate tabs, bans         | `docs/architecture/roster.md`                                   |
| Games, slot, host loop                       | `docs/architecture/game-framework.md`                           |
| `joinRoom`, `Room`                           | `docs/architecture/room.md`                                     |
| Screens, header, toasts, dialogs, game pages | `docs/architecture/ui.md`                                       |
| Adding a game                                | `docs/guides/creating-a-game.md`                                |
| Numbers and timers                           | `docs/guides/configuration.md` and each layer's `config.ts`     |
| Style and structure                          | `docs/reference/conventions.md`                                 |

Docs rules: each page starts with one sentence saying when to read it, stays under about 150 lines, and is updated when behavior changes.

## Layers

```
kernel -> transport -> bus -> roster, game -> room -> ui
```

A layer imports only from layers below it, through its `index.ts`. `roster` and `game` never import each other. No hooks below `ui`. Do not add import-boundary lint rules. Real implementations exist only in `src/adapters/` and `src/compose.ts`. Fakes are imported directly (`@/bus/fakes`), never through a barrel.

## Invariants (never break)

- Network input is untrusted and validated. Only the host-verified sender is trusted.
- `playerId` is durable. `peerId` is fresh per join and never reused.
- Only the current host's death may be inferred from a closed link or a missed offer. `reportSuspectedDeath` is destructive.
- Never close links on a host change. Clear offer watches on every host change.
- Reducers are pure functions of (state, payload).
- Teardown order: client wiring, bus, presence, session. `leave` is idempotent.
- No Firestore heartbeats or polling. No new reads without a clear need.
- Channels register before `bus.start()`.
- TURN secrets stay server side, never `NEXT_PUBLIC_`.

Full list: `docs/reference/invariants.md`.

## Conventions

- Everything touching the outside world is an injected port (Clock, IdGenerator, Logger, KeyValueStore, PageLifecycle, Entropy, Storages, Firestore and RTC ports). No `setTimeout`, `Date.now`, `crypto`, `window`, `document`, storage or `console` below `adapters/` and `compose.ts`.
- Classes and flows take one deps object and only their own config section.
- State is a `Store`, moments are `Listenable`, lifetime is a `Scope`. Intents return `Result` and do not throw for expected failures.
- Pure decisions in `rules.ts`, literals in `names.ts`, numbers in `config.ts` with a reason, durations in ms.
- Ids come from `IdGenerator` (ULID: the host election relies on creation-time order).
- Delete dead code instead of keeping it. Do not add features beyond the request.

Details: `docs/reference/conventions.md`.

## How to work

- Compact replies. State which file changes and why.
- Prefer precise change instructions (file, old code, new code). Give a full file when it is new, heavily changed, or asked for.
- Ask only when a decision matters: one question, with a recommended default.
- If you cannot run the code, say what is unverified and give a short test checklist.
- Do not write tests unless asked. Keep code testable (ports, pure cores).
- Run `pnpm check` (eslint, tsc, vitest) before declaring a change done, when you can.

## Commands

`pnpm dev`, `pnpm build`, `pnpm check`, `pnpm test`, `pnpm format`.
