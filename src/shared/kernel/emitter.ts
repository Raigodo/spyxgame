export type Unsubscribe = () => void;

// No-payload emitters (`Emitter`) take emit(); everything else takes emit(value).
type EmitArgs<T> = [T] extends [void] ? [] : [value: T];

// Listeners are isolated: one throwing never stops the others. Emission iterates a
// copy, so a listener may unsubscribe while being called.
export class Emitter<T = void> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private readonly onError: (error: unknown) => void = rethrowLater) {}

  on(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: EmitArgs<T>): void {
    const value = (args as unknown[])[0] as T;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(value);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}
