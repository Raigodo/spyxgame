import { describe, expect, it } from "vitest";
import { isInt, isRecord } from "./guards";

describe("guards", () => {
  it("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
  it("isInt rejects floats, NaN and strings", () => {
    expect(isInt(3)).toBe(true);
    expect(isInt(3.5)).toBe(false);
    expect(isInt(NaN)).toBe(false);
    expect(isInt("3")).toBe(false);
  });
});
