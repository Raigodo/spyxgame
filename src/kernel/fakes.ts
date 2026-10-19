import type { Unsubscribe } from "./reactive/emitter";
import { Emitter } from "./reactive/emitter";
import type { Cancel, Clock } from "./ports/clock";
import type { Entropy } from "./ports/entropy";
import type { IdGenerator } from "./ports/id-generator";
import type { KeyValueStore } from "./ports/key-value-store";
import type { Logger, LogLevel } from "./ports/logger";
import type { PageLifecycle } from "./ports/page-lifecycle";

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }
  set(key: string, value: string): void {
    this.values.set(key, value);
  }
  remove(key: string): void {
    this.values.delete(key);
  }
}

export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

export class NullPageLifecycle implements PageLifecycle {
  onPageHide(): Unsubscribe {
    return () => {};
  }
}

/** A page lifecycle a test fires by hand. */
export class FakePageLifecycle implements PageLifecycle {
  private readonly handlers = new Emitter();

  onPageHide(handler: () => void): Unsubscribe {
    return this.handlers.on(handler);
  }
  /** Fires pagehide, like a refresh or close does just before the page goes away. */
  hide(): void {
    this.handlers.emit();
  }
}

/** Sequential ids that sort in creation order, like ULIDs. */
export class FakeIds implements IdGenerator {
  private n = 0;
  next(): string {
    return `id-${String(++this.n).padStart(4, "0")}`;
  }
}

/** Seeds 1, 2, 3, ... */
export class FakeEntropy implements Entropy {
  constructor(private n = 1) {}
  seed(): number {
    return this.n++;
  }
}

interface Timer {
  at: number;
  fn: () => void;
  every?: number;
}

export class FakeClock implements Clock {
  private time = 0;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();

  now(): number {
    return this.time;
  }
  after(ms: number, fn: () => void): Cancel {
    return this.schedule({ at: this.time + ms, fn });
  }
  every(ms: number, fn: () => void): Cancel {
    return this.schedule({ at: this.time + ms, fn, every: ms });
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let next: Timer | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at)) {
          nextId = id;
          next = timer;
        }
      }
      if (nextId === undefined || !next) break;
      this.time = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(nextId);
      next.fn();
    }
    this.time = end;
  }

  private schedule(timer: Timer): Cancel {
    const id = ++this.seq;
    this.timers.set(id, timer);
    return () => {
      this.timers.delete(id);
    };
  }
}

export interface LogEntry {
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export class RecordingLogger implements Logger {
  constructor(
    readonly entries: LogEntry[] = [],
    private readonly scope = "test"
  ) {}

  debug(message: string, data?: unknown): void {
    this.add("debug", message, data);
  }
  info(message: string, data?: unknown): void {
    this.add("info", message, data);
  }
  warn(message: string, data?: unknown): void {
    this.add("warn", message, data);
  }
  error(message: string, data?: unknown): void {
    this.add("error", message, data);
  }
  child(scope: string): Logger {
    return new RecordingLogger(this.entries, `${this.scope}:${scope}`);
  }
  messages(level?: LogLevel): string[] {
    return this.entries.filter((e) => !level || e.level === level).map((e) => e.message);
  }

  private add(level: LogLevel, message: string, data: unknown): void {
    this.entries.push({ level, scope: this.scope, message, data });
  }
}
