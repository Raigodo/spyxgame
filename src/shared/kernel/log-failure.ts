import type { Logger } from "./logger";

/** For fire-and-forget promises: `void p.catch(logFailure(log, "send offer"))`. */
export function logFailure(logger: Logger, what: string): (error: unknown) => void {
  return (error) => logger.warn(`${what} failed`, error);
}
