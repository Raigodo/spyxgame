import { Emitter, type Unsubscribe } from "./emitter";
import { schedule, type Store } from "./store";

export type ValuesOf<D extends readonly Store<unknown>[]> = {
  -readonly [K in keyof D]: D[K] extends Store<infer V> ? V : never;
};

class Derived<R> implements Store<R> {
  private inputs?: readonly unknown[];
  private value?: R;
  private emitted?: R;
  private subscribers = 0;
  private offs: Unsubscribe[] = [];
  private readonly changed = new Emitter<{ value: R }>();

  constructor(
    private readonly deps: readonly Store<unknown>[],
    private readonly fn: (...values: unknown[]) => R,
    private readonly equals: (a: R, b: R) => boolean
  ) {}

  // Pull-based and memoized: recomputes only if a dependency's reference changed, and an equal
  // result keeps the old reference.
  get(): R {
    const next = this.deps.map((dep) => dep.get());
    const prev = this.inputs;
    if (prev && next.every((v, i) => Object.is(v, prev[i]))) return this.value as R;
    const computed = this.fn(...next);
    if (prev === undefined || !this.equals(this.value as R, computed)) this.value = computed;
    this.inputs = next;
    return this.value as R;
  }

  // Connects to the dependencies only while it has subscribers, so it cannot leak.
  subscribe(fn: (value: R) => void): Unsubscribe {
    const off = this.changed.on(({ value }) => fn(value));
    if (this.subscribers++ === 0) this.connect();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      if (--this.subscribers === 0) this.disconnect();
    };
  }

  private connect(): void {
    this.emitted = this.get();
    this.offs = this.deps.map((dep) => dep.subscribe(this.onDependency));
  }

  private disconnect(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private readonly onDependency = (): void => schedule(this.notify);

  private readonly notify = (): void => {
    const next = this.get();
    if (Object.is(next, this.emitted)) return;
    this.emitted = next;
    this.changed.emit({ value: next });
  };
}

/** A read-only store computed from other stores. Lazy, memoized, no Scope needed. */
export function derived<const D extends readonly Store<unknown>[], R>(
  deps: D,
  fn: (...values: ValuesOf<D>) => R,
  equals: (a: R, b: R) => boolean = Object.is
): Store<R> {
  return new Derived<R>(deps, fn as unknown as (...values: unknown[]) => R, equals);
}
