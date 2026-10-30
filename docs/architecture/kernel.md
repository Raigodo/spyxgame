# Kernel

Read when you need a reactive primitive, a schema, a config knob or a port. The kernel is pure building blocks: it knows nothing about transport, rooms or games.

## Reactive core

| Primitive                      | What it is                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Store<T>`                     | Read side: `get()` and `subscribe(fn)`. What public APIs expose                                                                                                                              |
| `Cell<T>`                      | Owner side of a store. `set(next)` and `update(fn)` return `true` if the value changed; options `{ equals?, onError? }`, with `equals` it keeps the old reference when equal                 |
| `derived(deps, fn, equals?)`   | Read-only store computed from other stores. Lazy and memoized                                                                                                                                |
| `batch(fn)`                    | Writes land now; notifications run once at the end of the outermost batch                                                                                                                    |
| `Listenable<E>` / `Emitter<E>` | Read side (`on`) / owner side (`on`, `emit`, `clear`) of an event. A throwing listener never stops the others; its error goes to the constructor's `onError`, default rethrow in a microtask |
| `Scope`                        | Disposable ownership. See below                                                                                                                                                              |

`derived` recomputes only when a dependency's reference changed, keeps the old reference when the result is equal, and connects to its dependencies only while it has subscribers. It cannot leak.

```ts
const total = derived([a, b] as const, (x, y) => x + y);
batch(() => {
  a.set(1);
  b.set(2);
}); // one notification
```

### Scope

```ts
const scope = new Scope({ onError: (e) => log.error("Cleanup failed", e) }); // scope.disposed
scope.add(cleanup); // runs on dispose, in reverse order; at once if already disposed
scope.on(emitter, fn); // listen until disposed
scope.watch(store, fn); // call now with the current value, then on every change
// on/watch do nothing if already disposed
const child = scope.child(); // disposed with the parent
scope.dispose(); // idempotent, each cleanup isolated
```

Cleanups run **last registered first**, so teardown order is the reverse of construction order. That rule is enforced by structure instead of by comments.

## Results and ids

```ts
type Result<T, R> = { ok: true; value: T } | { ok: false; reason: R };
ok();
ok(value);
fail(reason);
```

Ids are branded strings: `PlayerId`, `PeerId`, `RoomId`, `ChannelId`. Mixing a peer id and a player id is a compile error. `as<PlayerId>(raw)` casts, and is used only where a value is created or parsed. `ID_LIMITS` holds one length cap per kind (player 128, peer 64, room 32, channel 96).

## Schema

All network input goes through schemas.

```ts
const schema = s.object({
  name: s.string({ min: 1, max: 32 }),
  tags: s.list(s.string({ max: 8 }), { max: 5, onInvalid: "drop" }),
  extra: s.optional(s.int({ min: 0, max: 9 })),
});
schema.check(input); // Result<T, { path, expected }>
schema.parse(input); // T | undefined
```

Available: `string`, `int`, `number` (finite, no options), `boolean`, `literal(...values)`, `oneOf(options)`, `id(kind)` (length from `ID_LIMITS`), `list(item, { max, onInvalid })`, `record(value, { maxKeys, onInvalid })`, `object`, `optional`, `tagged(tag, variants)`, `json({ maxChars })`, `nullable`, `custom(fn)`. Types: `Infer`, `Issue`, `JsonValue`.

- **Limits are required options** (`string.max`, `int.min/max`, `list.max`, `record.maxKeys`, `json.maxChars`); only `string.min` defaults (0). Numbers come from config.
- **`onInvalid: "reject" | "drop"` is explicit** on `list` and `record`.
- **Safe by construction:** `object` returns only declared keys, `record` rejects a `__proto__` key, `json` bounds size and depth.
- `check` carries the dotted path of the first failure (`Issue`), used in the throttled `{from, kind, path}` bus warning.
- `custom` is for payloads whose shape depends on another field (the game slot).

## Config descriptors

```ts
export const linkConfig = defineConfig("link", {
  offerTimeoutMs: timer(12_000, { why: "...", destructive: true }),
  maxChunkChars: limit(12_000, { why: "..." }),
  iceServers: value<readonly IceServer[]>([...], "..."),
});
type LinkConfig = ConfigValues<typeof linkConfig>;
resolveConfig(linkConfig, { maxChunkChars: 8_000 }); // undefined override keeps the default
```

Every knob carries a `why`. `destructive` is optional (default false); `timer` and `limit` take `{ why }`, `value` takes `why` as a plain string. `destructive: true` marks a timer whose wrong firing can remove a live peer. **All durations are milliseconds.** Defaults live in the owning layer's `config.ts`. `transport` (signaling, link) and `roster` use descriptors; `bus` and `game` use plain objects for now.

## Ports

| Port            | API                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Clock`         | `now()`, `after(ms, fn)`, `every(ms, fn)`. Both return a cancel function                                                                             |
| `IdGenerator`   | `next()` (returns string). ULIDs in production: ids sort by creation time and the election relies on it                                              |
| `Logger`        | `debug/info/warn/error(message, data?)`, `child(scope)`                                                                                              |
| `KeyValueStore` | `get(key)` (string or undefined), `set(key, value, { ttlMs? })`, `remove(key)`. Best effort, never throws. `prefixed(store, prefix)` namespaces keys |
| `PageLifecycle` | `onPageHide(handler)`                                                                                                                                |
| `Entropy`       | `seed()`: unsigned 32-bit int, the only source of per-round randomness                                                                               |
| `Storages`      | Three named stores: `tab`, `profile`, `device`                                                                                                       |

The three storages: `tab` survives a refresh of the same tab and is gone for a new tab (sessionStorage); `profile` is long-lived per browser (cookie, holds the nickname); `device` is per device with expiry (localStorage, holds game-local state).

Real implementations are in `src/adapters/`: `SystemClock`, `UlidIdGenerator`, `ConsoleLogger`, `BrowserPageLifecycle`, `SessionStorageAdapter`, `CookieStorageAdapter`, `LocalStorageAdapter`, `CryptoEntropy`, `TurnIceServerSource` (an ICE server source, not a kernel port).

## Pure helpers

`Countdown(clock, onExpired)` (`start(ms)`, `stop()`, `isRunning()`), `isRecord`, `isInt`, `structurallyEqual`, `seededRandom(seed)` (mulberry32, floats in [0, 1)), `shortId` (last 8 chars), `createThrottledWarn(logger, clock, intervalMs = 5000)` (one warning per key per interval, next one carries `suppressed`), `logFailure(logger, what)`, `listenerFailure(getLogger)`.

Fire-and-forget promises use `void p.catch(logFailure(log, "what"))`. Emitter errors use `listenerFailure`.

## Fakes

`@/kernel/fakes`: `FakeClock` (`advance(ms)` fires due timers in order), `FakeIds`, `FakeEntropy`, `MemoryKeyValueStore`, `NullLogger`, `RecordingLogger`, `FakePageLifecycle` (`hide()`), `NullPageLifecycle`, `nextMacrotask`. `MemoryKeyValueStore` ignores `ttlMs`. `@/kernel/scoped-clock` exports `ScopedClock(base)`: one tab's own view of a shared clock so `kill()` can cancel everything it scheduled.
