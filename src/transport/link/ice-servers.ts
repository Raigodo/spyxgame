import { logFailure, type Clock, type Logger } from "@/kernel";
import type { IceServer } from "../config";
import type { IceServerSource } from "../ports";

export interface ResolveIceServersDeps {
  source: IceServerSource;
  clock: Clock;
  logger: Logger;
  /** STUN-only list used on failure, timeout or an empty answer. */
  fallback: readonly IceServer[];
  timeoutMs: number;
}

/** Called once per join, so relay credentials are fresh. Never rejects. */
export async function resolveIceServers(
  deps: ResolveIceServersDeps
): Promise<readonly IceServer[]> {
  let cancel: () => void = () => {};
  const timeout = new Promise<undefined>((resolve) => {
    cancel = deps.clock.after(deps.timeoutMs, () => resolve(undefined));
  });
  try {
    const fetched = await Promise.race([deps.source.fetch(), timeout]);
    return fetched && fetched.length > 0 ? fetched : deps.fallback;
  } catch (error) {
    logFailure(deps.logger, "fetch ice servers")(error);
    return deps.fallback;
  } finally {
    cancel();
  }
}
