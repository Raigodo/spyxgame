import type { Logger } from "./logger";

/** For fire-and-forget promises: `void p.catch(logFailure(log, "send offer"))`. */
export function logFailure(logger: Logger, what: string): (error: unknown) => void {
  return (error) => logger.warn(`${what} failed`, error);
}

/**
 * Emitter error handler that logs under the owner's scope instead of rethrowing:
 * `new Emitter(listenerFailure(() => this.log))`. The logger is fetched lazily, so it is safe in
 * field initializers.
 */
export function listenerFailure(getLogger: () => Logger): (error: unknown) => void {
  return (error) => getLogger().error("Listener failed", error);
}
