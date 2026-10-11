# Conventions

Short rules for working in this codebase. The architecture overview is in [design.md](./design.md), with reference docs in [docs/](./docs). If a doc disagrees with the code on intent, ask. On a detail, the code wins.

## Layers

kernel -> infrastructure (signaling, webrtc, player) -> application (messaging, presence, lobby, chat, game, room) -> presentation (React).

- Dependencies point downward only. No React hooks below presentation.
- Everything touching the outside world is injected as a port: Clock, IdGenerator, Logger, KeyValueStore, PageLifecycle, Firestore ports, RTC ports. No direct `setTimeout`, `Date.now`, `crypto`, `window`, `document`, `sessionStorage` or `console` below presentation.

## Classes and files

- A class takes one `deps` object, and only its own config section.
- Decision logic goes in pure functions in their own files. Classes stay thin shells that wire them to ports.
- One exported class per file. Kebab-case file names with a role suffix (`-port`, `-adapter`, `-service`, `-store`, `-controller`).
- Delete dead code instead of keeping it. Do not add features beyond the request.

## Events and state

- Use `Emitter` with a single payload. `on...` returns the `Unsubscribe` of its own registration, never `clear()`. `clear()` is only for owner teardown.
- A value the client exposes is a `Store<T>` behind a getter and one matching `on...` callback. It notifies only on real change and keeps its reference otherwise.
- Intents return typed results and do not throw for expected failures.
- Timers go through `Clock.after` / `every` and are cancelled on teardown. Ids come from `IdGenerator` (ULID: the election relies on sort order).
- Host-owned state that must survive a host change is a bus state channel. Ephemeral traffic is an event channel.

## Network input

- All network input is untrusted and parsed at the boundary (`parseWire`, `parseEnvelope`, `parsePresenceEvent`, `parseRtcSignal`, per-channel validators). Only the host-verified sender is trusted.
- Use the kernel `isRecord` and `isInt`. A test fails if they are redefined elsewhere.
- Dropped invalid input is logged with `{from, kind}` through `createThrottledWarn`.

## Removing peers

- Another peer is deleted from membership only through `PeerRemover.remove(peerId, reason)`.
- `reportSuspectedDeath` is destructive. The host is removed only when the collection window ends without its link returning.
- A new timer that can remove a live peer must be listed in [docs/timers.md](./docs/timers.md) as destructive.

## Logging and errors

- Use a scoped `Logger` (`logger.child("name")`). Levels per scope: `NEXT_PUBLIC_LOG_SCOPES="bus:debug"`.
- Fire-and-forget promises use `logFailure`. `catch(() => {})` is not used.
- Emitter listener errors use `listenerFailure` so they are logged under the owner's scope.
- A stateful class exposes a read-only `inspect()` returning plain JSON (no state values, no metadata).

## Naming

- `use*` is for React hooks only. Non-hook accessors are `get*`.
- Words: **peer** (`peerId`, one page load, never reused), **player** (`playerId`, durable), **member** (a membership doc), **link** (an RTC channel). See [docs/glossary.md](./docs/glossary.md).

## Tests

- Test the pure core first. Multi-peer behavior goes through `RoomHarness` (fake Firestore, RTC and clock). The harness uses real `setImmediate`, so do not use `vi.useFakeTimers()` with it.
- A new config timer must get a row in [docs/timers.md](./docs/timers.md), or `timer-inventory.test.ts` fails.
- Doc-driven tests read table rows by their `` | `name` `` prefix.
- `pnpm check` (lint, types, tests) must pass before a commit.

## Adding things

- **A game:** one `defineGame` definition, one `{definition, route}` entry in `presentation/room/games.ts`, one page. Never touch networking.
- **A bus wire kind:** extend `Wire` and `parseWire`, add its handler to `wireHandlers` (the compiler requires it).
- **A presence event:** extend `PresenceEvent` and its parser, handle it in `handleEvent`, keeping the branch order (pong before the host-only guards). Anything that must survive a host change goes in `presence:history` or a new state channel.
- **A port:** interface in `ports/`, adapter in `adapters/`, injected through the owner's deps, default wired in the layer's `index.ts`, override in `createMultiplayerClient`, a fake for tests.
- **A timer or limit:** add it to the matching config section with a comment, read it from the injected config, add its row to `docs/timers.md`.
- **Host-only behavior:** use `hostOnly: true` commands; the logic must work from replicated state alone.
