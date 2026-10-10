import type { Unsubscribe } from "@/shared/kernel";

/** One per simulated tab. After kill(), its Firestore calls hang and its subscriptions stop. */
export class FakePortLife {
  private dead = false;
  private readonly subscriptions: Unsubscribe[] = [];

  get isDead(): boolean {
    return this.dead;
  }

  /** Resolves with fn() while alive (fn runs now). A dead tab's calls never finish. */
  run<T>(fn: () => T): Promise<T> {
    return this.dead ? new Promise<T>(() => {}) : Promise.resolve(fn());
  }

  subscribe(register: () => Unsubscribe): Unsubscribe {
    if (this.dead) return () => {};
    const off = register();
    this.subscriptions.push(off);
    return off;
  }

  kill(): void {
    this.dead = true;
    for (const off of this.subscriptions.splice(0)) off();
  }
}
