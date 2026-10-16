# Conventions

Read before writing code here. Architecture: [overview.md](./overview.md). If a doc disagrees with the code on intent, ask. On a detail, the code wins.

## Layers and ports

kernel, then infrastructure, then application, then presentation. Dependencies point down only. No React hooks below presentation.

Everything touching the outside world is an injected port: `Clock`, `IdGenerator`, `Logger`, `KeyValueStore`, `PageLifecycle`, Firestore ports, RTC ports. Below presentation: no direct `setTimeout`, `Date.now`, `crypto`, `window`, `document`, `sessionStorage`, `localStorage` or `console`.

## Classes and files

- A class takes one `deps` object, and only its own config section.
- Decision logic goes in pure functions in their own files. Classes stay thin shells that wire them to ports.
- One exported class per file. Kebab-case names with a role suffix (`-port`, `-adapter`, `-service`, `-store`, `-controller`).
- Delete dead code instead of keeping it. Do not add features beyond the request.

## Events and state

- `Emitter` with a single payload. `on...` returns its own `Unsubscribe`, never `clear()`. `clear()` is for owner teardown only.
- A value the client exposes is a `Store<T>` behind one getter and one matching `on...` callback. It notifies only on a real change and keeps its reference otherwise.
- Intents return typed results and never throw for expected failures.
- Timers go through `Clock.after` / `every` and are cancelled on teardown. Ids come from `IdGenerator` (ULID: the election relies on the sort order).
- Host-owned state that must survive a host change is a bus state channel. Ephemeral traffic is an event channel.

## Network input

- All network input is untrusted and parsed at the boundary. Only the host-verified sender is trusted.
- Use the kernel `isRecord` and `isInt` (a test fails if they are redefined).
- Dropped invalid input is logged with `{from, kind}` through `createThrottledWarn`.

## Removing peers

- Another peer leaves membership only through `PeerRemover.remove(peerId, reason)`.
- A new timer that can remove a live peer must be listed in [timers.md](./timers.md) as destructive.

## Logging and errors

- Scoped `Logger` (`logger.child("name")`), levels per scope with `NEXT_PUBLIC_LOG_SCOPES`.
- Fire-and-forget promises use `logFailure`. `catch(() => {})` is not used. Emitter listener errors use `listenerFailure`.
- A stateful class exposes a read-only `inspect()` returning plain JSON (no state values, no metadata).

## Naming

- `use*` is for React hooks only. Non-hook accessors are `get*`.
- **peer** (`peerId`, one page load), **player** (`playerId`, durable), **member** (a membership doc), **link** (an RTC channel). See [glossary.md](./glossary.md).

## Tests

- Test the pure core first. Multi-peer behavior goes through `RoomHarness`. Do not use `vi.useFakeTimers()` with it. Details: [concepts/testing.md](./concepts/testing.md).
- A new config timer needs a row in [timers.md](./timers.md).
- `pnpm check` must pass before a commit.

## Adding things

- **A game:**
  1. One `defineGame` definition.
  2. One `{definition, route}` entry in `presentation/room/games.ts`.
  3. One entry in `presentation/room/lobby-games.ts` (label, modes, a `Starter` component taking `initialConfig`).
  4. One page, and a spec in `docs/games/<id>.md`.
  5. Never touch networking. Read [concepts/games.md](./concepts/games.md) first.
  - Anything that must reach everyone from the state (round over, someone scored): an `emit` effect, not page diffing.
  - A timed rule: a `timers` handler plus `startTimer`, never a timeout in a page.
  - Notes or UI memory that must survive a refresh: `defineLocalState`, never `window.localStorage`.
  - Secret per-player data: `privateState` with a deterministic `recover`. Never keep secrets in `state`.
  - Shape of config or state changed: bump `version` and add `migrate`.
  - A game with away or quorum rules: set `presence`, and make quorum checks ignore `away` players.
- **A bus wire kind:** extend `Wire` and `parseWire`, add its handler to `wireHandlers` (the compiler requires it).
- **A presence event:** extend `PresenceEvent` and its parser, handle it in `handleEvent` keeping the branch order. Anything that must survive a host change goes in `presence:history` or a new state channel.
- **A port:** interface in `ports/`, adapter in `adapters/`, injected through the owner's deps, default wired in the layer's `index.ts`, override in `createMultiplayerClient`, a fake for tests.
- **A timer or limit:** add it to the matching config section with a comment, read it from the injected config, add its row to `docs/timers.md`.
- **Host-only behavior:** use `hostOnly: true` commands. The logic must work from replicated state alone.
