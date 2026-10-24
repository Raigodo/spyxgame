/**
 * Resolves after pending microtasks and I/O callbacks have run. Used instead of setTimeout(0):
 * timers have coarse granularity on some platforms (about 15ms on Windows), setImmediate does not.
 */
export const nextMacrotask = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));
