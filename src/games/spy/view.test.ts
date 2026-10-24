import { describe, expect, it } from "vitest";
import { initialSpyState, type SpyReason, type SpyState } from "./rules";
import { canForceAdvance, rejectionText, resultText, waitingFor } from "./view";

const st = (o: Partial<SpyState>): SpyState => ({
  ...initialSpyState(),
  order: ["a", "b", "c"],
  spyId: "c",
  ...o,
});

describe("waitingFor", () => {
  it("talking: the current speaker, even when away", () => {
    expect(waitingFor(st({ phase: "talking", turn: 1 }))).toEqual(["b"]);
    expect(waitingFor(st({ phase: "talking", turn: 1 }), ["b"])).toEqual(["b"]);
    expect(waitingFor(st({ phase: "talking", turn: 9 }))).toEqual([]);
  });
  it("deciding and voting: whoever has not answered, minus the away", () => {
    expect(waitingFor(st({ phase: "deciding", decisions: { a: "vote" } }), ["b"])).toEqual(["c"]);
    expect(waitingFor(st({ phase: "voting", votes: { a: "b", b: "a", c: "a" } }))).toEqual([]);
    expect(waitingFor(st({ phase: "voting", votes: { a: "b" } }))).toEqual(["b", "c"]);
  });
  it("last chance: the spy; collecting and ended: nobody; no spy: nobody", () => {
    expect(waitingFor(st({ phase: "lastChance" }))).toEqual(["c"]);
    expect(waitingFor(st({ phase: "lastChance", spyId: undefined }))).toEqual([]);
    expect(waitingFor(st({ phase: "collecting" }))).toEqual([]);
    expect(waitingFor(st({ phase: "ended" }))).toEqual([]);
  });
  it("a pending claim: the other players who have not voted, minus the away", () => {
    const claim = { from: "talking" as const, votes: { a: true } };
    expect(waitingFor(st({ phase: "talking", claim }))).toEqual(["b"]);
    expect(waitingFor(st({ phase: "talking", claim }), ["b"])).toEqual([]);
  });
});

describe("canForceAdvance", () => {
  it("true while something is waiting to be resolved", () => {
    for (const phase of ["deciding", "voting", "lastChance"] as const) {
      expect(canForceAdvance(st({ phase }))).toBe(true);
    }
    expect(canForceAdvance(st({ phase: "talking", claim: { from: "talking", votes: {} } }))).toBe(
      true
    );
  });
  it("false while collecting, talking without a claim, or ended", () => {
    for (const phase of ["collecting", "talking", "ended"] as const) {
      expect(canForceAdvance(st({ phase }))).toBe(false);
    }
  });
});

describe("texts", () => {
  it("every result reason has its own text", () => {
    const reasons: SpyReason[] = [
      "spy-guessed",
      "spy-caught-guessed",
      "spy-failed-guess",
      "wrong-accusation",
      "spy-caught",
    ];
    const texts = reasons.map(resultText);
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(5);
  });
  it("known rejections are readable, unknown ones are shown as they are", () => {
    expect(rejectionText("not-your-turn")).toBe("It is not your turn.");
    expect(rejectionText("paused")).toMatch(/paused/);
    expect(rejectionText("host-only")).toBe("Only the host can do that.");
    expect(rejectionText("zzz")).toBe("Rejected: zzz");
  });
});
