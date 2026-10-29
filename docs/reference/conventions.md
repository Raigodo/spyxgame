# Conventions

Read before writing code in this repository.

## Dependencies

- Layers: kernel -> transport -> bus -> roster, game -> room -> ui. Import a layer through its `index.ts`.
- Classes and flows take one deps object and only their own config section.
- Real implementations exist only in `src/adapters/` and `src/compose.ts`.

## Ports

Clock, IdGenerator (ULID), Logger (scoped), KeyValueStore, PageLifecycle, Entropy, Storages, Firestore and RTC ports. No `setTimeout`, `Date.now`, `crypto`, `window`, `document`, storage or `console` in infrastructure or application.

## Public API shape

- State is a `Store<T>`, moments are `Listenable<E>`, lifetime is a `Scope`.
- A store changes only on real change and returns a stable reference until then.
- Intents return `Result<T, Reason>`; they never throw for expected failures.
- No hook-like names on non-hooks.

## Structure

- Decisions are pure functions in `rules.ts`. Flows stay thin.
- Literals live in `names.ts`; numbers in `config.ts` with a `why`; all durations in ms.
- Fire-and-forget promises: `void p.catch(logFailure(log, "what"))`.

## Docs and process

- Compact answers; state which file changes and why.
- Delete dead code instead of keeping it.
- Do not add features beyond the request.
- Update docs in the same change as behavior. Each doc starts with one sentence saying when to read it, and stays under about 150 lines.
- Tests are next to the code (`*.test.ts`); never combine harnesses with `vi.useFakeTimers()`.
