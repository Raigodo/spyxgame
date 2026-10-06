export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Same sink and level, scope extended: `webrtc` -> `webrtc:registry`. */
  child(scope: string): Logger;
}
