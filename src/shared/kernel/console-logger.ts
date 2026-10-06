import type { Logger, LogLevel } from "./logger";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

// Resolved per call, not captured, so tests can spy on console.
const SINKS: Record<LogLevel, (...args: unknown[]) => void> = {
  // console.log, not console.debug: browsers hide "Verbose" by default.
  debug: (...args) => console.log(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const isLogLevel = (value: string | undefined): value is LogLevel =>
  LEVELS.some((level) => level === value);

/** NEXT_PUBLIC_LOG_LEVEL wins; otherwise debug in development and warn in production. */
export function defaultLogLevel(): LogLevel {
  const fromEnv = process.env.NEXT_PUBLIC_LOG_LEVEL;
  if (isLogLevel(fromEnv)) return fromEnv;
  return process.env.NODE_ENV === "production" ? "warn" : "debug";
}

export class ConsoleLogger implements Logger {
  constructor(
    private readonly scope: string,
    private readonly level: LogLevel = defaultLogLevel()
  ) {}

  debug(message: string, data?: unknown): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.write("error", message, data);
  }

  child(scope: string): Logger {
    return new ConsoleLogger(`${this.scope}:${scope}`, this.level);
  }

  private write(level: LogLevel, message: string, data: unknown): void {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.level)) return;
    const line = `[${this.scope}] ${message}`;
    if (data === undefined) SINKS[level](line);
    else SINKS[level](line, data);
  }
}
