# Testing

Read before writing or debugging a test.

## Layers of tests

1. **Pure cores first.** Rules live in pure functions in their own files, so most tests need no fakes.
2. **Classes** with injected fakes (`FakeClock`, `RecordingLogger`, fake ports).
3. **Multi-peer scenarios** on `RoomHarness`. Pages are the regression boundary above that.
4. **Doc-driven tests.** `timer-inventory.test.ts` requires a row in `docs/timers.md` for every timer in `DEFAULT_CONFIG`, and checks relations between timers.

## RoomHarness

N real `MultiplayerClient`s over one fake Firestore, one fake RTC network and one fake clock (each tab has a `ScopedClock`).

- `join`, `refresh` (pagehide, old tab dies, new client rejoins with the same playerId), `kill(detectionMs)` (abrupt death: no leave, no pagehide, far ends notice after the delay), `silence()` (link stays open, nothing flows).
- `advance(ms)` moves fake time and lets async work finish. `settle()` lets pending promises and macrotasks finish.
- `recordMilestones` records when conditions first become true, and `failover-timeline.test.ts` prints the result.
- `firestore.stats` counts reads, writes and deletes, to guard the cost priority.

## Rules and traps

- The harness waits with real `setImmediate`. **Never use `vi.useFakeTimers()` with it.**
- The harness keeps the real timer config, so timelines stay meaningful.
- Approximations (documented on the class): snapshot listeners fire before the causing write resolves; a first snapshot arrives before the caller registers handlers; a link opens when the offerer applies the answer; ICE is one fake candidate per description.
- **Not testable with the fakes:** real link timing, ICE batching on real networks, TURN.
- Local game state needs a `MemoryKeyValueStore` passed through `localStore`. Without it the browser adapter no-ops under node.
- A new config timer needs its `docs/timers.md` row or the inventory test fails.
- `pnpm check` (lint, types, tests) must pass before a commit.
