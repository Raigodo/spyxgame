import { describe, expect, it } from "vitest";
import { defineConfig, limit, resolveConfig, timer, value } from "./define-config";

const def = defineConfig("demo", {
  waitMs: timer(1_000, { why: "w", destructive: true }),
  calmMs: timer(5, { why: "c" }),
  cap: limit(10, { why: "l" }),
  list: value<readonly string[]>(["a"], "v"),
});

describe("defineConfig", () => {
  it("exposes defaults from the knobs, frozen", () => {
    expect(def.defaults).toEqual({ waitMs: 1_000, calmMs: 5, cap: 10, list: ["a"] });
    expect(Object.isFrozen(def.defaults)).toBe(true);
    expect(def.name).toBe("demo");
  });

  it("timers are non-destructive unless flagged; kinds are tagged", () => {
    expect(def.knobs.waitMs).toMatchObject({ kind: "timer", destructive: true });
    expect(def.knobs.calmMs).toMatchObject({ kind: "timer", destructive: false });
    expect(def.knobs.cap.kind).toBe("limit");
    expect(def.knobs.list.kind).toBe("value");
  });
});

describe("resolveConfig", () => {
  it("applies overrides without mutating the defaults", () => {
    const out = resolveConfig(def, { cap: 3 });
    expect(out.cap).toBe(3);
    expect(out.waitMs).toBe(1_000);
    expect(def.defaults.cap).toBe(10);
  });

  it("an explicit undefined override keeps the default; unknown keys are ignored", () => {
    const out = resolveConfig(def, { cap: undefined, bogus: 1 } as never);
    expect(out.cap).toBe(10);
    expect("bogus" in out).toBe(false);
  });

  it("works with no overrides", () => {
    expect(resolveConfig(def)).toEqual(def.defaults);
  });
});
