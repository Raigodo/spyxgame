# Zoom-in 1: kernel

Read before touching `kernel/`. It fixes the kernel's public API and what changes from today's `src/shared/kernel` (task 1 of [plan.md](./plan.md)). Written after reading the current kernel (908 lines, 22 files); nothing run or typechecked.

## What the kernel is

Pure building blocks plus port interfaces. It never touches `window`, `document`, `console`, `setTimeout`, `Date.now` or `crypto`, and it knows nothing about slices, so no feature's settings live here. Every other layer imports it through one barrel, `kernel/index.ts`.

Most of it exists. The work is five additions (reactive core, `Scope`, `Result`/ids, schema, config descriptors), two ports (`Telemetry`, `Entropy`), and moving the real-world adapters and `AppConfig` out.

## Public API (the frozen surface)

### Reactive core

```ts
interface Store<T> {
  get(): T;
  subscribe(fn: (v: T) => void): Unsubscribe;
} // read side, what APIs expose
interface Listenable<T> {
  on(fn: (v: T) => void): Unsubscribe;
} // read side of an Emitter

class Cell<T> implements Store<T> {
  // owner side (today's `Store` class)
  constructor(
    initial: T,
    opts?: { equals?: (a: T, b: T) => boolean; onError?: (e: unknown) => void }
  );
  set(next: T): boolean; // true if changed; old reference kept when equal
  update(fn: (cur: T) => T): boolean;
}
class Emitter<T = void> implements Listenable<T> {
  on;
  emit;
  clear;
} // unchanged

function batch(fn: () => void): void; // writes land now, notifications run once at the end
function derived<const D extends readonly Store<unknown>[], R>(
  deps: D,
  fn: (...v: ValuesOf<D>) => R,
  equals?
): Store<R>;

class Scope {
  constructor(deps: { onError(e: unknown): void });
  add(cleanup: () => void): void; // runs LIFO on dispose; runs at once if already disposed
  on<T>(source: Listenable<T>, fn: (v: T) => void): void;
  watch<T>(store: Store<T>, fn: (v: T) => void): void;
  child(): Scope;
  dispose(): void; // idempotent, each cleanup isolated
  readonly disposed: boolean;
}
```

- **`derived` is lazy and memoized, with no `Scope` needed.** `get()` re-reads its deps and recomputes only if a dep reference changed; an equal result keeps the old reference. It subscribes to deps only while it has subscribers, so it cannot leak and `useSyncExternalStore` gets stable snapshots. Two deps changing inside one `batch` give one notification.
- **No `flatten`.** It was planned for a client facade that stays stable across rejoin; the room zoom-in ([zoom-4](./zoom-4-roster-client.md)) dropped that facade, so nothing needs it. Add it back only if a later layer must follow a store that changes identity.
- **`batch` replaces `stage`.** Today only `RoomRosterView` uses `stage` (two stores, one atomic update). `Cell.reset` is dropped: it exists for teardown, which `Scope` replaces.
- **`Scope` order is reverse construction.** Build session, presence, bus, wiring in that order and dispose runs wiring, bus, presence, session: today's documented teardown-order invariant, enforced by structure. Timers join with `scope.add(clock.after(...))`.

### Results and ids

```ts
type Result<T, R> = { ok: true; value: T } | { ok: false; reason: R }
const ok: <T>(value: T) => Result<T, never>;  const fail: <R>(reason: R) => Result<never, R>
// Result<void, R>: ok() with no argument

type Brand<T, B extends string> = T & { readonly __brand: B }
type PlayerId = Brand<string, "PlayerId">   // also PeerId, RoomId, ChannelId
as<Kind>(s: string)                          // cast, only where a value is created or parsed
```

Mixing `peerId` and `playerId` is the glossary's classic hazard, and brands make it a compile error. One length cap per id kind lives in `ids.ts` (replaces today's 32/40/64/100/128 scattered across files); pick the value when implementing, after checking the five current caps.

### Schema (parse untrusted input)

```ts
interface Schema<T> { check(input: unknown): Result<T, Issue>; parse(input: unknown): T | undefined }   // Issue = { path, expected }

s.string({ max }) · s.int({ min, max }) · s.number() · s.boolean() · s.literal(...) · s.oneOf([...])
s.id("player" | "peer" | "room" | "channel")
s.list(item, { max, onInvalid })  · s.record(value, { maxKeys, onInvalid })
s.object({ a: s.string({ max: 40 }), b: s.optional(s.int({ min: 0, max: 9 })) })
s.tagged("kind", { join: s.object({...}), leave: s.object({...}) })       // discriminated union
s.json({ maxChars })                                                       // opaque JSON payload, size-capped
s.nullable(inner)  · s.custom(fn)                                          // `custom`: a check returning a Result with a path, for payloads whose schema depends on another field (game slots)
type Infer<S>
```

- **Limits are required options** (no defaults), so numbers come from the slice's config and `names.ts`.
- **`onInvalid: "reject" | "drop"` is explicit** on `list` and `record` (today's status map drops, others reject).
- **Safe by construction:** `object` returns only declared keys, `record` rejects `__proto__`, `s.json` bounds size.
- **`check` carries the path of the first failure** for the throttled `{from, kind}` warning that conventions already require; `parse` is `check` without the reason.
- `isRecord` and `isInt` stay as plain guards (a test already enforces one definition).

### Config descriptors

```ts
const linkConfig = defineConfig("link", {
  offerTimeoutMs: timer(12_000, { protects: "...", ifTooShort: "...", ifTooLong: "...", destructive: true }),
  maxChunkChars:  limit(12_000, { protects: "..." }),
  iceServers:     value<readonly IceServer[]>([...], "doc"),
})
type LinkConfig = ConfigValues<typeof linkConfig>    // linkConfig.defaults, resolveConfig(def, overrides)
renderConfigDoc(defs): string                        // pure; `pnpm docs:config` writes docs/config.md
```

- **Every knob has a descriptor and a required doc.** Today's rule "a timer that can remove a live peer is listed as destructive" becomes a flag the generator reads; `docs/timers.md` and `timer-inventory.test.ts` retire.
- **One unit: milliseconds.** `*Seconds` knobs (`localTtlSeconds`, `cookieMaxAgeSeconds`) become `*Ms`, and `KeyValueStore.set` takes `ttlMs`; the cookie adapter converts.
- **Defaults live in the owning slice's `config.ts`;** kernel holds only the descriptors and the doc renderer. `AppConfig` and the seven section types leave the kernel.
- **Cross-timer relations** (today's `timer relations` tests) are plain `{ name, holds(all) }` objects in `compose/relations.ts`, run by one generic check, because only compose sees every slice's config.

### Ports

| Port            | API                                                      | Change                                                                                                                                                                        |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Clock`         | `now`, `after`, `every`                                  | unchanged                                                                                                                                                                     |
| `IdGenerator`   | `next(): string`                                         | unchanged; slices wrap results with `as<...>`                                                                                                                                 |
| `Logger`        | `debug/info/warn/error`, `child(scope)`                  | unchanged                                                                                                                                                                     |
| `KeyValueStore` | `get`, `set(key, value, { ttlMs? })`, `remove`           | `ttlSeconds` becomes `ttlMs`; plus `prefixed(store, prefix)` helper                                                                                                           |
| `PageLifecycle` | `onPageHide`                                             | unchanged                                                                                                                                                                     |
| `Telemetry`     | `event(name, props?)` with scalar props                  | new; no-op by default                                                                                                                                                         |
| `Entropy`       | `seed(): number`                                         | new; the only source of randomness for per-round seeds                                                                                                                        |
| `Storages`      | `{ tab, profile, device }`, three named `KeyValueStore`s | new; replaces the string prefixes (`host-claim:`, `player-profile:`, `game-local:`) that identify the backend; each slice's `names.ts` supplies its own `prefixed` key prefix |

Pure helpers kept: `Countdown`, `structurallyEqual`, `createThrottledWarn`, `logFailure`, `listenerFailure`, `shortId`. New pure helper: `seededRandom(seed): () => number`, so reducers get deterministic randomness from a seed the framework supplies.

## Fate of today's files

| Today                                                                                     | Fate                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `emitter.ts`                                                                              | keep; add `Listenable`                                                                                                                           |
| `store.ts`                                                                                | becomes `Cell`; add `Store` interface, `batch`, `derived`; drop `stage`/`reset`                                                                  |
| `clock.ts`                                                                                | interface stays; `SystemClock` moves to `src/adapters/`                                                                                          |
| `id-generator.ts`, `short-id.ts`                                                          | keep; `UlidIdGenerator` moves to `src/adapters/`                                                                                                 |
| `logger.ts`, `null-logger.ts`                                                             | keep                                                                                                                                             |
| `console-logger.ts`, `log-levels.ts`                                                      | move to `src/adapters/` (use `console` and env)                                                                                                  |
| `key-value-store.ts`, `memory-key-value-store.ts`                                         | keep; `ttlMs`, add `prefixed`                                                                                                                    |
| `page-lifecycle.ts`                                                                       | keep; `BrowserPageLifecycle` moves to `src/adapters/`                                                                                            |
| `config.ts`                                                                               | splits into per-slice `config.ts`; kernel keeps only the descriptors                                                                             |
| `guards.ts`, `structural-equal.ts`, `countdown.ts`, `throttled-warn.ts`, `log-failure.ts` | keep                                                                                                                                             |
| tests                                                                                     | keep the pure ones (`store`, `structural-equal`, `guards`, `throttled-warn`, `countdown`); `timer-inventory`, `config`, `harness` retire or move |

New files: `scope.ts`, `derived.ts`, `result.ts`, `ids.ts`, `schema/`, `config/define-config.ts`, `ports/telemetry.ts`, `ports/entropy.ts`, `seeded-random.ts`. Estimated size: about 500 new lines.

Layout: `kernel/{reactive,schema,config,ports,util}/` plus `index.ts` and `fakes.ts` (Memory/Null implementations). Real-world adapters (`SystemClock`, `UlidIdGenerator`, `ConsoleLogger`, `BrowserPageLifecycle`, cookie/local/session storage, `Entropy` via `crypto`) go in `src/adapters/` and are imported only by `compose.ts`.

## Decisions made here

1. Public read types are `Store` and `Listenable`; owners hold `Cell` and `Emitter`. This corrects the plan's use of `Store` for both sides.
2. `batch` instead of `stage`; no `reset`.
3. `derived` is lazy and pull-based; no global dependency graph; no `flatten`.
4. `Scope` has `add`, `on`, `watch`, `child`, `dispose`, and late `add` runs immediately.
5. Schema `check` returns `Result` with a path; limits are required options; unknown keys are stripped.
6. All time knobs are milliseconds.
7. Real adapters live outside the kernel, imported only by `compose.ts`.

## Not decided here

- Id length caps (see above) and exact `Issue` text.
- Which slice owns which config keys: that falls out of the transport and bus zoom-ins.
- Relation list contents: carried over from `timer-inventory.test.ts` when `compose/relations.ts` is written.
- Open point 9 of the plan: the `Telemetry` port and `renderConfigDoc` are deferred until something consumes them, and descriptors may shrink to one `why` string plus the `destructive` flag.

## Done when

- Barrel exports exactly the surface above.
- Every export has a unit test for its edge cases: `derived` memoization and glitch-free `batch`, `Scope` LIFO, error isolation and late `add`, schema strip, drop and reject paths.
- `pnpm check` is green on the kernel alone.
- Next: zoom-in 2, transport.
