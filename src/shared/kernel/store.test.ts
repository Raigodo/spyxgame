import { describe, expect, it, vi } from "vitest";
import { Store } from "./store";
import { structurallyEqual } from "./structural-equal";

describe("Store", () => {
  it("notifies only on a real change", () => {
    const store = new Store(1);
    const seen = vi.fn();
    store.subscribe(seen);
    expect(store.set(1)).toBe(false);
    expect(store.set(2)).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(2);
  });
  it("keeps the old reference when the new value is structurally equal", () => {
    const store = new Store([{ a: 1 }], structurallyEqual);
    const first = store.get();
    expect(store.set([{ a: 1 }])).toBe(false);
    expect(store.get()).toBe(first);
  });
  it("stage updates now and notifies later", () => {
    const store = new Store(1);
    const seen = vi.fn(() => expect(store.get()).toBe(2));
    store.subscribe(seen);
    const notify = store.stage(2);
    expect(store.get()).toBe(2);
    expect(seen).not.toHaveBeenCalled();
    notify?.();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.stage(2)).toBeUndefined();
  });
  it("reset changes the value silently", () => {
    const store = new Store(1);
    const seen = vi.fn();
    store.subscribe(seen);
    store.reset(5);
    expect(store.get()).toBe(5);
    expect(seen).not.toHaveBeenCalled();
  });
  it("unsubscribe stops delivery, and a throwing listener is reported without stopping others", () => {
    const errors: unknown[] = [];
    const store = new Store(0 as number, Object.is, (e) => errors.push(e));
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.set(1);
    off();
    store.set(2);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(2);
  });
});
