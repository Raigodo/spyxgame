import { Emitter, type PageLifecycle, type Unsubscribe } from "@/shared/kernel";

export class FakePageLifecycle implements PageLifecycle {
  private readonly handlers = new Emitter();

  onPageHide(handler: () => void): Unsubscribe {
    return this.handlers.on(handler);
  }

  /** Fires pagehide, like a refresh or close does just before the page goes away. */
  hide(): void {
    this.handlers.emit();
  }
}
