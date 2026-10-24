import { describe, expect, it } from "vitest";
import { Cell, batch } from "./store";
import { derived } from "./derived";
import { Emitter } from "./emitter";
import { Scope } from "./scope";

describe("Cell", () => {
  it("keeps the old reference when equal and reports change", () => {
    const c = new Cell({ a: 1 }, { equals: (x, y) => x.a === y.a });
    const first = c.get();
    expect(c.set({ a: 1 })).toBe(false);
    expect(c.get()).toBe(first);
    expect(c.set({ a: 2 })).toBe(true);
    expect(c.get()).toEqual({ a: 2 });
  });

  it("notifies synchronously once per real change; update works", () => {
    const c = new Cell(1);
    const seen: number[] = [];
    c.subscribe((v) => seen.push(v));
    c.set(2);
    c.set(2);
    c.update((n) => n + 1);
    expect(seen).toEqual([2, 3]);
  });

  it("isolates a throwing listener and reports it to onError", () => {
    const errors: unknown[] = [];
    const c = new Cell(0, { onError: (e) => errors.push(e) });
    const seen: number[] = [];
    c.subscribe(() => {
      throw new Error("boom");
    });
    c.subscribe((v) => seen.push(v));
    c.set(1);
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it("unsubscribe stops notifications", () => {
    const c = new Cell(0);
    const seen: number[] = [];
    const off = c.subscribe((v) => seen.push(v));
    c.set(1);
    off();
    c.set(2);
    expect(seen).toEqual([1]);
  });
});

describe("batch", () => {
  it("writes land at once, notifications run once at the end", () => {
    const a = new Cell(1);
    const b = new Cell(2);
    const sum = derived([a, b] as const, (x, y) => x + y);
    const seen: number[] = [];
    sum.subscribe((v) => seen.push(v));
    batch(() => {
      a.set(10);
      expect(a.get()).toBe(10);
      b.set(20);
    });
    expect(seen).toEqual([30]);
  });

  it("a batch that ends where it began notifies nobody", () => {
    const a = new Cell(1);
    const seen: number[] = [];
    a.subscribe((v) => seen.push(v));
    batch(() => {
      a.set(2);
      a.set(1);
    });
    expect(seen).toEqual([]);
  });

  it("nested batches flush only at the outermost end", () => {
    const a = new Cell(0);
    const seen: number[] = [];
    a.subscribe((v) => seen.push(v));
    batch(() => {
      batch(() => a.set(1));
      expect(seen).toEqual([]);
      a.set(2);
    });
    expect(seen).toEqual([2]);
  });
});

describe("derived", () => {
  it("is lazy and memoized", () => {
    let calls = 0;
    const a = new Cell(1);
    const d = derived([a] as const, (x) => {
      calls++;
      return x * 2;
    });
    expect(calls).toBe(0);
    expect(d.get()).toBe(2);
    expect(d.get()).toBe(2);
    expect(calls).toBe(1);
    a.set(2);
    expect(d.get()).toBe(4);
    expect(calls).toBe(2);
  });

  it("keeps the old reference when the result is equal", () => {
    const a = new Cell(1);
    const d = derived(
      [a] as const,
      (x) => ({ big: x > 5 }),
      (p, q) => p.big === q.big
    );
    const first = d.get();
    a.set(2);
    expect(d.get()).toBe(first);
    a.set(9);
    expect(d.get()).not.toBe(first);
  });

  it("notifies only when the result changes", () => {
    const a = new Cell(1);
    const d = derived([a] as const, (x) => x % 2);
    const seen: number[] = [];
    d.subscribe((v) => seen.push(v));
    a.set(3); // still odd
    a.set(4);
    expect(seen).toEqual([0]);
  });

  it("connects to deps only while it has subscribers", () => {
    let calls = 0;
    const a = new Cell(1);
    const d = derived([a] as const, (x) => {
      calls++;
      return x;
    });
    const off = d.subscribe(() => {});
    a.set(2);
    const during = calls;
    off();
    off(); // harmless
    a.set(3);
    expect(calls).toBe(during);
    expect(d.get()).toBe(3);
  });

  it("derived of derived works", () => {
    const a = new Cell(1);
    const d1 = derived([a] as const, (x) => x + 1);
    const d2 = derived([d1] as const, (x) => x * 10);
    const seen: number[] = [];
    d2.subscribe((v) => seen.push(v));
    a.set(2);
    expect(seen).toEqual([30]);
  });
});

describe("Emitter", () => {
  it("emits to all, isolates errors, allows unsubscribe while emitting", () => {
    const errors: unknown[] = [];
    const e = new Emitter<number>((err) => errors.push(err));
    const seen: number[] = [];
    e.on(() => {
      throw new Error("x");
    });
    const off = e.on((v) => {
      seen.push(v);
      off();
    });
    e.on((v) => seen.push(v * 10));
    e.emit(1);
    e.emit(2);
    expect(seen).toEqual([1, 10, 20]);
    expect(errors).toHaveLength(2);
  });

  it("clear removes every listener; no-payload emitter takes emit()", () => {
    const e = new Emitter();
    let n = 0;
    e.on(() => n++);
    e.emit();
    e.clear();
    e.emit();
    expect(n).toBe(1);
  });
});

describe("Scope", () => {
  const make = () => {
    const errors: unknown[] = [];
    return { scope: new Scope({ onError: (e) => errors.push(e) }), errors };
  };

  it("runs cleanups in reverse order, idempotently", () => {
    const { scope } = make();
    const order: number[] = [];
    scope.add(() => order.push(1));
    scope.add(() => order.push(2));
    scope.add(() => order.push(3));
    scope.dispose();
    scope.dispose();
    expect(order).toEqual([3, 2, 1]);
    expect(scope.disposed).toBe(true);
  });

  it("isolates a throwing cleanup", () => {
    const { scope, errors } = make();
    const ran: string[] = [];
    scope.add(() => ran.push("a"));
    scope.add(() => {
      throw new Error("boom");
    });
    scope.add(() => ran.push("c"));
    scope.dispose();
    expect(ran).toEqual(["c", "a"]);
    expect(errors).toHaveLength(1);
  });

  it("a late add runs at once", () => {
    const { scope } = make();
    scope.dispose();
    let ran = false;
    scope.add(() => (ran = true));
    expect(ran).toBe(true);
  });

  it("child is disposed with the parent, before earlier registrations", () => {
    const { scope } = make();
    const order: string[] = [];
    scope.add(() => order.push("parent-first"));
    const child = scope.child();
    child.add(() => order.push("child"));
    scope.dispose();
    expect(order).toEqual(["child", "parent-first"]);
    expect(child.disposed).toBe(true);
  });

  it("on: listens until disposed, and not at all if already disposed", () => {
    const { scope } = make();
    const e = new Emitter<number>();
    const seen: number[] = [];
    scope.on(e, (v) => seen.push(v));
    e.emit(1);
    scope.dispose();
    e.emit(2);
    scope.on(e, (v) => seen.push(v));
    e.emit(3);
    expect(seen).toEqual([1]);
  });

  it("watch: current value now, then changes, until disposed", () => {
    const { scope } = make();
    const c = new Cell(1);
    const seen: number[] = [];
    scope.watch(c, (v) => seen.push(v));
    c.set(2);
    scope.dispose();
    c.set(3);
    expect(seen).toEqual([1, 2]);
  });
});
