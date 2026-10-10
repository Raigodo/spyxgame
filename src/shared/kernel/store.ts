import { Emitter, type Unsubscribe } from "./emitter";

/**
 * One value with change notification. Keeps the old reference when the new value is equal, so
 * get() is stable between real changes (what useSyncExternalStore needs).
 */
export class Store<T> {
  private value: T;
  private readonly changed: Emitter<{ value: T }>;

  constructor(
    initial: T,
    private readonly equals: (a: T, b: T) => boolean = Object.is,
    onListenerError?: (error: unknown) => void
  ) {
    this.value = initial;
    this.changed = new Emitter<{ value: T }>(onListenerError);
  }

  get(): T {
    return this.value;
  }

  /** Updates now if the value differs; returns a function that notifies, or undefined if equal. */
  stage(next: T): (() => void) | undefined {
    if (this.equals(this.value, next)) return undefined;
    this.value = next;
    return () => this.changed.emit({ value: next });
  }

  /** Updates and notifies. Returns whether anything changed. */
  set(next: T): boolean {
    const notify = this.stage(next);
    notify?.();
    return notify !== undefined;
  }

  /** Updates without notifying (teardown). */
  reset(next: T): void {
    this.value = next;
  }

  subscribe(handler: (value: T) => void): Unsubscribe {
    return this.changed.on(({ value }) => handler(value));
  }
}
