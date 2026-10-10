import { describe, expect, it } from "vitest";
import { structurallyEqual } from "./structural-equal";

describe("structurallyEqual", () => {
  it("compares primitives, including NaN", () => {
    expect(structurallyEqual(1, 1)).toBe(true);
    expect(structurallyEqual(NaN, NaN)).toBe(true);
    expect(structurallyEqual(1, "1")).toBe(false);
    expect(structurallyEqual(null, undefined)).toBe(false);
  });
  it("compares nested objects and arrays by value, key order ignored", () => {
    expect(structurallyEqual({ a: [1, { b: 2 }], c: 3 }, { c: 3, a: [1, { b: 2 }] })).toBe(true);
    expect(structurallyEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
  });
  it("tells arrays and objects apart", () => {
    expect(structurallyEqual([], {})).toBe(false);
    expect(structurallyEqual({ 0: "a" }, ["a"])).toBe(false);
  });
  it("treats undefined-valued properties as absent", () => {
    expect(structurallyEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(structurallyEqual({ a: 1, b: null }, { a: 1 })).toBe(false);
  });
  it("detects a change in a field nobody listed", () => {
    const p = { peerId: "a", metadata: { readyRound: 1, extra: "x" } };
    expect(structurallyEqual([p], [{ ...p, metadata: { readyRound: 1, extra: "y" } }])).toBe(false);
  });
});
