import { describe, expect, it } from "vitest";
import { ID_LIMITS } from "../ids";
import { s } from "./schema";

const issueOf = (r: { ok: boolean; reason?: unknown }) =>
  (r as { ok: false; reason: { path: string; expected: string } }).reason;

describe("primitives", () => {
  it("string respects min and max", () => {
    const sc = s.string({ min: 2, max: 4 });
    expect(sc.parse("ab")).toBe("ab");
    expect(sc.parse("a")).toBeUndefined();
    expect(sc.parse("abcde")).toBeUndefined();
    expect(sc.parse(1)).toBeUndefined();
  });

  it("int rejects floats, out of range and non-numbers", () => {
    const sc = s.int({ min: 0, max: 9 });
    expect(sc.parse(5)).toBe(5);
    expect(sc.parse(1.5)).toBeUndefined();
    expect(sc.parse(10)).toBeUndefined();
    expect(sc.parse("5")).toBeUndefined();
  });

  it("number rejects NaN and Infinity; boolean is strict", () => {
    expect(s.number().parse(1.5)).toBe(1.5);
    expect(s.number().parse(NaN)).toBeUndefined();
    expect(s.number().parse(Infinity)).toBeUndefined();
    expect(s.boolean().parse(true)).toBe(true);
    expect(s.boolean().parse(1)).toBeUndefined();
  });

  it("literal and oneOf accept only the listed values", () => {
    expect(s.literal("a", 2).parse(2)).toBe(2);
    expect(s.literal("a", 2).parse("b")).toBeUndefined();
    expect(s.oneOf(["x", "y"]).parse("y")).toBe("y");
    expect(s.oneOf(["x", "y"]).parse("z")).toBeUndefined();
  });

  it("id enforces 1..cap of its kind", () => {
    const sc = s.id("room");
    expect(sc.parse("abc")).toBe("abc");
    expect(sc.parse("")).toBeUndefined();
    expect(sc.parse("x".repeat(ID_LIMITS.room))).toBeDefined();
    expect(sc.parse("x".repeat(ID_LIMITS.room + 1))).toBeUndefined();
  });

  it("nullable accepts null or the inner type", () => {
    const sc = s.nullable(s.int({ min: 0, max: 9 }));
    expect(sc.parse(null)).toBeNull();
    expect(sc.parse(3)).toBe(3);
    expect(sc.parse(undefined)).toBeUndefined();
  });

  it("custom passes the function's result through", () => {
    const sc = s.custom<number>((v) =>
      typeof v === "number"
        ? { ok: true, value: v }
        : { ok: false, reason: { path: "p", expected: "n" } }
    );
    expect(sc.parse(1)).toBe(1);
    expect(issueOf(sc.check("x")).path).toBe("p");
  });
});

describe("object", () => {
  const sc = s.object({ a: s.int({ min: 0, max: 9 }), b: s.optional(s.string({ max: 3 })) });

  it("strips unknown keys", () => {
    expect(sc.parse({ a: 1, extra: true })).toEqual({ a: 1 });
  });

  it("optional may be absent or undefined, but must be valid when present", () => {
    expect(sc.parse({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(sc.parse({ a: 1, b: "xy" })).toEqual({ a: 1, b: "xy" });
    expect(sc.parse({ a: 1, b: "toolong" })).toBeUndefined();
  });

  it("rejects non-objects, arrays and a missing required key", () => {
    expect(sc.parse(null)).toBeUndefined();
    expect(sc.parse([])).toBeUndefined();
    expect(sc.parse({})).toBeUndefined();
  });

  it("reports the dotted path of the first failure", () => {
    const nested = s.object({ a: s.object({ b: s.int({ min: 0, max: 1 }) }) });
    expect(issueOf(nested.check({ a: { b: 5 } })).path).toBe("a.b");
    expect(issueOf(nested.check("x")).path).toBe("");
  });

  it("does not read inherited keys", () => {
    const proto = { a: 1 };
    const child = Object.create(proto) as Record<string, unknown>;
    expect(sc.parse(child)).toBeUndefined();
  });
});

describe("list", () => {
  const item = s.int({ min: 0, max: 5 });

  it("drop keeps valid items; reject fails with the index", () => {
    expect(s.list(item, { max: 5, onInvalid: "drop" }).parse([1, 9, 2])).toEqual([1, 2]);
    const rejecting = s.list(item, { max: 5, onInvalid: "reject" });
    expect(issueOf(rejecting.check([1, 9])).path).toBe("1");
  });

  it("rejects too long lists and non-arrays even when dropping", () => {
    const sc = s.list(item, { max: 2, onInvalid: "drop" });
    expect(sc.parse([1, 2, 3])).toBeUndefined();
    expect(sc.parse("x")).toBeUndefined();
  });
});

describe("record", () => {
  const value = s.int({ min: 0, max: 5 });

  it("drop keeps valid entries; reject fails with the key", () => {
    expect(s.record(value, { maxKeys: 5, onInvalid: "drop" }).parse({ a: 1, b: 9 })).toEqual({
      a: 1,
    });
    const rejecting = s.record(value, { maxKeys: 5, onInvalid: "reject" });
    expect(issueOf(rejecting.check({ a: 1, b: 9 })).path).toBe("b");
  });

  it("enforces maxKeys and rejects a __proto__ key", () => {
    const sc = s.record(value, { maxKeys: 1, onInvalid: "drop" });
    expect(sc.parse({ a: 1, b: 2 })).toBeUndefined();
    expect(sc.parse(JSON.parse('{"__proto__":1}'))).toBeUndefined();
  });

  it("rejects arrays", () => {
    expect(s.record(value, { maxKeys: 5, onInvalid: "drop" }).parse([1])).toBeUndefined();
  });
});

describe("tagged", () => {
  const sc = s.tagged("kind", {
    a: s.object({ n: s.int({ min: 0, max: 9 }) }),
    b: s.object({}),
  });

  it("dispatches by tag, keeps the tag, strips extras", () => {
    expect(sc.parse({ kind: "a", n: 1, extra: 2 })).toEqual({ kind: "a", n: 1 });
    expect(sc.parse({ kind: "b" })).toEqual({ kind: "b" });
  });

  it("rejects an unknown or missing tag, and an invalid variant body", () => {
    expect(issueOf(sc.check({ kind: "zzz" })).path).toBe("kind");
    expect(sc.parse({})).toBeUndefined();
    expect(sc.parse({ kind: "a", n: 99 })).toBeUndefined();
    expect(sc.parse({ kind: "toString" })).toBeUndefined(); // not an own variant
  });
});

describe("json", () => {
  const sc = s.json({ maxChars: 30 });

  it("accepts plain JSON within the cap", () => {
    expect(sc.parse({ a: [1, "x", null, true] })).toEqual({ a: [1, "x", null, true] });
  });

  it("rejects oversize, undefined, non-finite numbers, functions and __proto__ keys", () => {
    expect(sc.parse("x".repeat(30))).toBeUndefined();
    expect(sc.parse(undefined)).toBeUndefined();
    expect(sc.parse(NaN)).toBeUndefined();
    expect(sc.parse(() => 1)).toBeUndefined();
    expect(sc.parse(JSON.parse('{"__proto__":1}'))).toBeUndefined();
  });

  it("rejects values nested deeper than the limit", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(s.json({ maxChars: 10_000 }).parse(deep)).toBeUndefined();
  });
});
