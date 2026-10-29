# Testing

Read when you write or run tests. The code is built so tests need no browser, no Firebase and no real time.

## Run

```bash
pnpm test         # vitest run, src/**/*.test.ts, Node
pnpm test:watch
pnpm check        # eslint + tsc + vitest
```

## Harnesses

| Harness            | Import              | Runs                                                                |
| ------------------ | ------------------- | ------------------------------------------------------------------- |
| `TransportHarness` | `@/transport/fakes` | N real transports on a fake Firestore, fake RTC network, fake clock |
| `FakeBusNetwork`   | `@/bus/fakes`       | N buses over an in-memory network                                   |
| `RosterHarness`    | `@/roster/fakes`    | Roster on a fake bus network                                        |
| `GameHarness`      | `@/game/fakes`      | Game framework on roster + bus                                      |
| `RoomHarness`      | `@/room/fakes`      | Full `joinRoom` for N tabs                                          |

Each tab has a scoped clock, so `kill()` cancels everything that tab scheduled (a crash) and `leave()` is a clean exit.

## Style

- Pure cores (`rules.ts`) are tested by calling functions with data.
- Flows are tested through a harness: join tabs, act, `advance` the fake clock, assert stores.
- Fakes live in `fakes.ts` and are imported directly, never through the barrel.

## Pitfalls

- **Never combine a harness with `vi.useFakeTimers()`.** The fake clock is the only clock. Waits for promises use real `setImmediate` (`nextMacrotask`).
- Advance in steps that cover the real windows (for example, failover needs about 17 s of fake time).
- A test that needs a real WebRTC or Firestore belongs to a contract test against the adapter, not here.
