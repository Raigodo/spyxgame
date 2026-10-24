import { useCallback, useState } from "react";
import type { GameHandle, GameTypes } from "@/game";

/** Sends game commands and keeps the last rejection as readable text. */
export function useCommand<T extends GameTypes>(
  handle: GameHandle<T>,
  describe: (reason: string) => string = (reason) => reason
) {
  const [error, setError] = useState<string | null>(null);
  const send = useCallback(
    async (command: T["command"]) => {
      const result = await handle.send(command);
      setError(result.ok ? null : describe(String(result.reason)));
    },
    [handle, describe]
  );
  return { send, error };
}
