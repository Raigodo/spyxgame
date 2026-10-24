import { describe, expect, it } from "vitest";
import { fail, ok } from "./result";
import { ID_LIMITS, as } from "./ids";

describe("Result", () => {
  it("ok with and without a value; fail carries the reason", () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
    expect(ok()).toEqual({ ok: true, value: undefined });
    expect(fail("nope")).toEqual({ ok: false, reason: "nope" });
  });
});

describe("ids", () => {
  it("as casts without changing the string; every kind has a positive cap", () => {
    expect(as<string & { readonly __brand: "X" }>("abc")).toBe("abc");
    for (const limit of Object.values(ID_LIMITS)) expect(limit).toBeGreaterThan(0);
  });
});
