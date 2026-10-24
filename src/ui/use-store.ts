import { useCallback, useSyncExternalStore } from "react";
import type { Store } from "@/kernel";

export function useStore<T>(store: Store<T>): T {
  const subscribe = useCallback((notify: () => void) => store.subscribe(() => notify()), [store]);
  const get = useCallback(() => store.get(), [store]);
  return useSyncExternalStore(subscribe, get, get);
}
