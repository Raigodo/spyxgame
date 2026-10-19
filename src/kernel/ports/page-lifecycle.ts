import type { Unsubscribe } from "../reactive/emitter";

/** Signals about the hosting page. In tests, a fake fires them by hand. */
export interface PageLifecycle {
  /** Fires when the page is being refreshed, closed or navigated away from. Best-effort. */
  onPageHide(handler: () => void): Unsubscribe;
}
