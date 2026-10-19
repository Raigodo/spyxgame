import { Emitter, type Unsubscribe } from "./emitter";

/** Read side of a value with change notification. What public APIs expose. */
export interface Store<T> {
  get(): T;
  subscribe(fn: (value: T) => void): Unsubscribe;
}

// ─── batch ──────────────────────────────────────────────────────────────────

let depth = 0;
const queued = new Set<() => void>();

function runSafely(run: () => void): void {
  try {
    run();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/** @internal Runs `run` now, or once at the end of the outermost batch (deduplicated). */
export function schedule(run: () => void): void {
  if (depth === 0) runSafely(run);
  else queued.add(run);
}

/** Writes land now; notifications run once, at the end of the outermost batch. */
export function batch(fn: () => void): void {
  depth++;
  try {
    fn();
  } finally {
    depth--;
    if (depth === 0) flush();
  }
}

function flush(): void {
  while (queued.size > 0) {
    const runs = Array.from(queued);
    queued.clear();
    for (const run of runs) runSafely(run);
  }
}

// ─── Cell ───────────────────────────────────────────────────────────────────

export interface CellOptions<T> {
  equals?: (a: T, b: T) => boolean;
  onError?: (error: unknown) => void;
}

/** Owner side of a Store. Keeps the old reference when the new value is equal. */
export class Cell<T> implements Store<T> {
  private value: T;
  private notified: T;
  private readonly equals: (a: T, b: T) => boolean;
  private readonly changed: Emitter<{ value: T }>;

  constructor(initial: T, options: CellOptions<T> = {}) {
    this.value = initial;
    this.notified = initial;
    this.equals = options.equals ?? Object.is;
    this.changed = new Emitter<{ value: T }>(options.onError);
  }

  get(): T {
    return this.value;
  }

  /** Returns true if the value changed. */
  set(next: T): boolean {
    if (this.equals(this.value, next)) return false;
    this.value = next;
    schedule(this.notify);
    return true;
  }

  update(fn: (current: T) => T): boolean {
    return this.set(fn(this.value));
  }

  subscribe(fn: (value: T) => void): Unsubscribe {
    return this.changed.on(({ value }) => fn(value));
  }

  // Compares with what listeners last saw, so a batch that ends where it began notifies nobody.
  private readonly notify = (): void => {
    if (this.equals(this.notified, this.value)) return;
    this.notified = this.value;
    this.changed.emit({ value: this.value });
  };
}
