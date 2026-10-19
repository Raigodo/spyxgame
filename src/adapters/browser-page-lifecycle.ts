import type { PageLifecycle, Unsubscribe } from "@/kernel";

export class BrowserPageLifecycle implements PageLifecycle {
  onPageHide(handler: () => void): Unsubscribe {
    if (typeof window === "undefined") return () => {}; // SSR
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }
}
