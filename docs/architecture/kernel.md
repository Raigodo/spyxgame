# Kernel

Read when you need a reactive primitive, a schema, a config knob or a port. The kernel is pure building blocks: it knows nothing about transport, rooms or games.

## Reactive core

| Primitive                      | What it is                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `Store<T>`                     | Read side: `get()` and `subscribe(fn)`. What public APIs expose                                                                 |
| `Cell<T>`                      | Owner side of a store. `set` returns `true` if the value changed; with an `equals` option it keeps the old reference when equal |
| `derived(deps, fn, equals?)`   | Read-only store computed from other stores. Lazy and memoized                                                                   |
| `batch(fn)`                    | Writes land now; notifications run once at the end of the outermost batch                                                       |
| `Listenable<E>` / `Emitter<E>` | Read side / owner side of an event. One throwing listener never stops the others                                                |
| `Scope`                        | Disposable ownership. See below                                                                                                 |

`derived` recomputes only when a dependency's reference changed, keeps the old reference when the result is equal, and connects to its dependencies only while it has subscribers. It cannot leak and is safe for `useSyncExternalStore`.

```ts
const total = derived([a, b] as const, (x, y) => x + y);
batch(() => {
  a.set(1);
  b.set(2);
}); // one notification
```

### Scope

```ts
const scope = new Scope({ onError: (e) => log.error("Cleanup failed", e) });
scope.add(cleanup); // runs on dispose, in reverse order; at once if already disposed
scope.on(emitter, fn); // listen until disposed
scope.watch(store, fn); // call now with the current value, then on every change
const child = scope.child(); // disposed with the parent
scope.dispose(); // idempotent, each cleanup isolated
```

Cleanups run **last registered first**, so teardown order is the reverse of construction order. That rule is enforced by structure instead of by comments.

## Results and ids

```ts
type Result<T, R> = { ok: true; value: T } | { ok: false; reason: R };
ok(value?);  fail(reason);
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

Available: `string`, `int`, `number`, `boolean`, `literal`, `oneOf`, `id`, `list`, `record`, `object`, `optional`, `tagged`, `json`, `nullable`, `custom`.

- **Limits are required options.** There are no defaults, so numbers come from config.
- **`onInvalid: "reject" | "drop"` is explicit** on `list` and `record`.
- **Safe by construction:** `object` returns only declared keys, `record` rejects a `__proto__` key, `json` bounds size and depth.
- `check` carries the dotted path of the first failure, for the throttled `{from, kind}` warning.
- `custom` is for payloads whose shape depends on another field (the game slot).

## Config descriptors

```ts
export const linkConfig = defineConfig("link", {
  offerTimeoutMs: timer(12_000, { why: "...", destructive: true }),
  maxChunkChars: limit(12_000, { why: "..." }),
  iceServers: value<readonly IceServer[]>([...], "..."),
});
type LinkConfig = ConfigValues<typeof linkConfig>;
resolveConfig(linkConfig, { maxChunkChars: 8_000 });
```

Every knob carries a `why`. `destructive: true` marks a timer whose wrong firing can remove a live peer. **All durations are milliseconds.** Defaults live in the owning layer's `config.ts`. `transport` and `roster` use descriptors; `bus` and `game` use plain objects for now.

## Ports

| Port            | API                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Clock`         | `now()`, `after(ms, fn)`, `every(ms, fn)`. Both return a cancel function                                             |
| `IdGenerator`   | `next()`. ULIDs in production: ids sort by creation time and the election relies on it                               |
| `Logger`        | `debug/info/warn/error(message, data?)`, `child(scope)`                                                              |
| `KeyValueStore` | `get`, `set(key, value, { ttlMs? })`, `remove`. Best effort, never throws. `prefixed(store, prefix)` namespaces keys |
| `PageLifecycle` | `onPageHide(handler)`                                                                                                |
| `Entropy`       | `seed()`: the only source of per-round randomness                                                                    |
| `Storages`      | Three named stores: `tab`, `profile`, `device`                                                                       |

The three storages: `tab` survives a refresh of the same tab and is gone for a new tab (sessionStorage); `profile` is long-lived per browser (cookie, holds the nickname); `device` is per device with expiry (localStorage, holds game-local state).

Real implementations are in `src/adapters/`: `SystemClock`, `UlidIdGenerator`, `ConsoleLogger`, `BrowserPageLifecycle`, `SessionStorageAdapter`, `CookieStorageAdapter`, `LocalStorageAdapter`, `CryptoEntropy`, `TurnIceServerSource`.

## Pure helpers

`Countdown` (restartable one-shot timer), `isRecord`, `isInt`, `structurallyEqual`, `seededRandom(seed)`, `shortId`, `createThrottledWarn`, `logFailure`, `listenerFailure`.

Fire-and-forget promises use `void p.catch(logFailure(log, "what"))`. Emitter errors use `listenerFailure`.

## Fakes

`@/kernel/fakes`: `FakeClock` (`advance(ms)` fires due timers in order), `FakeIds`, `FakeEntropy`, `MemoryKeyValueStore`, `NullLogger`, `RecordingLogger`, `FakePageLifecycle`, `nextMacrotask`. `@/kernel/scoped-clock` gives one tab its own view of a shared clock so `kill()` can cancel everything it scheduled.
