import type { Clock } from "./clock";
import type { Logger } from "./logger";

export type ThrottledWarn = (key: string, message: string, data?: Record<string, unknown>) => void;

/**
 * At most one warning per key per interval, so a misbehaving peer cannot flood the log. The next
 * warning after the interval carries `suppressed`: how many were skipped.
 */
export function createThrottledWarn(
  logger: Logger,
  clock: Clock,
  intervalMs = 5_000
): ThrottledWarn {
  const state = new Map<string, { at: number; suppressed: number }>();
  return (key, message, data) => {
    const now = clock.now();
    const entry = state.get(key);
    if (entry && now - entry.at < intervalMs) {
      entry.suppressed++;
      return;
    }
    const suppressed = entry?.suppressed ?? 0;
    state.set(key, { at: now, suppressed: 0 });
    logger.warn(message, suppressed > 0 ? { ...data, suppressed } : data);
  };
}
