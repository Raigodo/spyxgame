import type { Listenable } from "./emitter";
import type { Store } from "./store";

export interface ScopeDeps {
  onError(error: unknown): void;
}

/**
 * Disposable ownership. Cleanups run in reverse order of registration, so building
 * session, presence, bus, wiring tears down wiring, bus, presence, session.
 */
export class Scope {
  private readonly cleanups: Array<() => void> = [];
  private isDisposed = false;

  constructor(private readonly deps: ScopeDeps) {}

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Runs `cleanup` on dispose, or at once if the scope is already disposed. */
  add(cleanup: () => void): void {
    if (this.isDisposed) this.run(cleanup);
    else this.cleanups.push(cleanup);
  }

  /** Calls `fn` for each event until the scope is disposed. */
  on<T>(source: Listenable<T>, fn: (value: T) => void): void {
    if (this.isDisposed) return;
    this.add(source.on(fn));
  }

  /** Calls `fn` with the current value now, then on every change, until the scope is disposed. */
  watch<T>(store: Store<T>, fn: (value: T) => void): void {
    if (this.isDisposed) return;
    this.add(store.subscribe(fn));
    this.run(() => fn(store.get()));
  }

  child(): Scope {
    const child = new Scope(this.deps);
    this.add(() => child.dispose());
    return child;
  }

  /** Idempotent. Each cleanup is isolated: one throwing does not skip the rest. */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (let cleanup = this.cleanups.pop(); cleanup; cleanup = this.cleanups.pop()) {
      this.run(cleanup);
    }
  }

  private run(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.deps.onError(error);
    }
  }
}
