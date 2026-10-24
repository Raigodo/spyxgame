import { describe, expect, it } from "vitest";
import { as, type PlayerId } from "@/kernel";
import { admitLate, initialState, tap } from "./rules";

const p = as<PlayerId>;

describe("initialState", () => {
  it("everyone starts at zero", () => {
    expect(initialState([p("a"), p("b")])).toEqual({ scores: { a: 0, b: 0 } });
    expect(initialState([])).toEqual({ scores: {} });
  });
});

describe("tap", () => {
  it("counts a tap", () => {
    expect(tap({ scores: { a: 0 } }, p("a"), 3)).toEqual({ ok: true, value: { scores: { a: 1 } } });
  });
  it("an unknown player starts from zero", () => {
    const r = tap({ scores: {} }, p("z"), 3);
    expect(r.ok && r.value.scores).toEqual({ z: 1 });
  });
  it("the first to reach the goal wins", () => {
    const r = tap({ scores: { a: 2, b: 1 } }, p("a"), 3);
    expect(r).toEqual({ ok: true, value: { scores: { a: 3, b: 1 }, winner: "a" } });
  });
  it("no winner key before the goal", () => {
    const r = tap({ scores: { a: 0 } }, p("a"), 2);
    expect(r.ok && "winner" in r.value).toBe(false);
  });
  it("after a winner every tap is `game-over`", () => {
    expect(tap({ scores: { a: 3 }, winner: p("a") }, p("b"), 3)).toEqual({
      ok: false,
      reason: "game-over",
    });
  });
});

describe("admitLate", () => {
  it("adds a player at zero and keeps the others", () => {
    expect(admitLate({ scores: { a: 2 } }, p("c"))).toEqual({ scores: { a: 2, c: 0 } });
  });
  it("keeps the winner", () => {
    expect(admitLate({ scores: {}, winner: p("a") }, p("c")).winner).toBe("a");
  });
});
