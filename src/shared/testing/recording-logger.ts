import type { Logger, LogLevel } from "@/shared/kernel";

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
