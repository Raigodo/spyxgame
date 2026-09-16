/**
 * Fires `onVisible` when the page transitions from hidden back to visible —
 * e.g. the user switches back to this tab after it was backgrounded. A
 * no-op in non-browser environments (SSR). Knows nothing about Firestore,
 * heartbeats, or rooms; it's purely a Page Visibility API wrapper.
 */
export class VisibilityWatcher {
  private listener: (() => void) | null = null;

  constructor(private readonly onVisible: () => void) {}

  start(): void {
    if (typeof document === "undefined") return; // SSR / non-browser guard
    this.listener = () => {
      if (document.visibilityState === "visible") this.onVisible();
    };
    document.addEventListener("visibilitychange", this.listener);
  }

  stop(): void {
    if (this.listener && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.listener);
    }
    this.listener = null;
  }
}
