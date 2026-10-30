# Project structure

Read to find your way around the code and to learn the one rule about dependencies.

## Layout

```
src/
  kernel/      Stores, Scope, Result, schemas, config descriptors, ports, branded ids
  transport/   Star network: signaling (Firestore), links (WebRTC), relay, host-seat claim
  bus/         Replicated channels: state, event, private. The only user of transport
  roster/      Who is in the room: players, ghosts, duplicate tabs, kick and ban
  game/        Game framework: defineGame, slot, host loop, GameHandle
  room/        joinRoom: builds everything on one Scope and returns a Room
  games/       The games (demo-tap, spy) and the two game registries
  ui/          React: shell, header, lobby, dialogs, shared game-page pieces
  adapters/    Real-world implementations of kernel ports (clock, storage, logger, ...)
  compose.ts   The only file that picks real adapters
  app/         Next.js routes only
docs/
```

## The layering rule

Layers, bottom to top:

```
kernel -> transport -> bus -> roster, game -> room -> ui
```

A layer imports only from layers below it. `roster` and `game` are peers and never import each other: what one needs from the other arrives as an injected `Store` or `Listenable`, wired in `room/join.ts` (see `room/game-inputs.ts`).

Two conventions keep this honest:

- **Import a layer through its `index.ts` only.** Internals (`channels/`, `slot/`, `flow.ts`, `host-flow.ts`) are private.
- **Fakes are imported directly**, never through the barrel: `@/bus/fakes`, `@/roster/fakes`, `@/transport/fakes`, `@/game/fakes`.

No lint rule enforces this. It is a convention.

## The composition root

`src/compose.ts` is the one file that knows about `window`, Firestore, `RTCPeerConnection` and friends. It builds a `RoomDeps` (clock, ids, logger, storages, Firestore ports, RTC provider, ICE source, entropy, game list, config). Everything below receives its dependencies as arguments and has no defaults.

`getRoomDeps()` creates it lazily on first use in the browser, so importing never needs the Firebase environment.

## Anatomy of a layer folder

Not every folder has every file, but the shape is the same everywhere:

| File                                                   | Holds                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `index.ts`                                             | The public API. Nothing else is importable from outside        |
| `model.ts`                                             | Public types and network schemas                               |
| `config.ts`                                            | Tuning knobs and limits                                        |
| `names.ts`                                             | Channel ids, wire literals, storage prefixes, Firestore paths  |
| `rules.ts`                                             | Pure decisions: data in, decision out, no I/O                  |
| `state.ts`, `flow.ts`, `host-flow.ts`, `guest-flow.ts` | Thin shells that wire rules to ports and stores                |
| `ports.ts`, `ports/`, `adapters/`                      | Interfaces to the outside world and their real implementations |
| `fakes.ts`, `harness.ts`                               | In-memory versions for tests                                   |
| `*.test.ts`                                            | Tests, next to the code                                        |

Rules contain no I/O. Flows contain no decisions and no literals. Literals live in `names.ts` and `config.ts`.

## Code map

| Path                           | What is there                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `src/kernel/reactive`          | `Cell`, `derived`, `batch`, `Emitter`, `Scope`                                            |
| `src/kernel/schema`            | The `s.*` schema helper                                                                   |
| `src/kernel/config`            | `defineConfig`, `timer`, `limit`, `value`, `resolveConfig`                                |
| `src/kernel/ports`             | `Clock`, `IdGenerator`, `Logger`, `KeyValueStore`, `PageLifecycle`, `Entropy`, `Storages` |
| `src/transport/signaling`      | Firestore membership, signal inboxes, host document, election, peer removal               |
| `src/transport/link`           | WebRTC links, reconnection, probes, ICE batching, chunking, reclaim                       |
| `src/transport/relay`          | Envelopes, verified sender, `hello`, `bye`, star relay                                    |
| `src/transport/claim`          | The per-tab host-seat hint                                                                |
| `src/bus/channels`             | `state`, `event` and `private` channel implementations                                    |
| `src/game/slot`                | Slot features: `presence`, `timers`, `notices`, `private`                                 |
| `src/games/definitions.ts`     | React-free list of game definitions (goes into `RoomDeps.games`)                          |
| `src/games/modules.ts`         | UI registry: label, `Starter`, `Page` per game                                            |
| `src/app/room/[roomId]/[game]` | The one dynamic route that renders every game page                                        |
| `src/app/api/turn`             | TURN credential endpoint                                                                  |

## Next

[Architecture overview](../architecture/overview.md), then the page for the layer you are changing.
