// application/room/emitter.ts
// Handler sets that outlive join/leave cycles, so a subscriber never has to
// re-subscribe when the client rejoins or its inner components are rebuilt.

export class Emitter<A extends unknown[]> {
  private readonly handlers = new Set<(...args: A) => void>();

  on(handler: (...args: A) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(...args: A): void {
    for (const handler of Array.from(this.handlers)) handler(...args);
  }
}
