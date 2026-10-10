// Dev tool: `window.__room()` in the browser console returns the client's debug snapshot.
import type { MultiplayerClient } from "@/shared/application/room";

export interface DebugTarget {
  __room?: () => Record<string, unknown>;
}

/** Returns a function that removes the hook (only if it is still ours). */
export function installDebugHook(
  client: Pick<MultiplayerClient, "getDebugState">,
  target: DebugTarget = globalThis as unknown as DebugTarget
): () => void {
  const hook = () => client.getDebugState();
  target.__room = hook;
  return () => {
    if (target.__room === hook) delete target.__room;
  };
}
