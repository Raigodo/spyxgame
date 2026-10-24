import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  GOAL_RANGE,
  MAX_EMOJI_CHARS,
  MAX_PLAYERS,
  emoteSchema,
  settingsSchema,
  stateSchema,
  tapSchema,
} from "./schemas";

describe("settingsSchema", () => {
  it("accepts the goal range and the default", () => {
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(settingsSchema.parse({ goal: GOAL_RANGE.min })).toBeDefined();
    expect(settingsSchema.parse({ goal: GOAL_RANGE.max })).toBeDefined();
  });
  it("rejects out-of-range, fractional and missing goals; strips extras", () => {
    for (const goal of [0, GOAL_RANGE.max + 1, 1.5, "5"]) {
      expect(settingsSchema.parse({ goal })).toBeUndefined();
    }
    expect(settingsSchema.parse({})).toBeUndefined();
    expect(settingsSchema.parse({ goal: 3, extra: 1 })).toEqual({ goal: 3 });
  });
});

describe("stateSchema", () => {
  it("accepts scores with an optional winner", () => {
    expect(stateSchema.parse({ scores: { a: 1 } })).toEqual({ scores: { a: 1 } });
    expect(stateSchema.parse({ scores: { a: 1 }, winner: "a" })).toEqual({
      scores: { a: 1 },
      winner: "a",
    });
  });
  it("rejects negative or oversized scores and too many players", () => {
    expect(stateSchema.parse({ scores: { a: -1 } })).toBeUndefined();
    expect(stateSchema.parse({ scores: { a: GOAL_RANGE.max + 1 } })).toBeUndefined();
    const crowd = Object.fromEntries(
      Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => [`p${i}`, 0])
    );
    expect(stateSchema.parse({ scores: crowd })).toBeUndefined();
  });
});

describe("command and event schemas", () => {
  it("tap", () => {
    expect(tapSchema.parse({ type: "tap" })).toEqual({ type: "tap" });
    expect(tapSchema.parse({ type: "other" })).toBeUndefined();
  });
  it("emote needs an emoji of 1..max characters", () => {
    expect(emoteSchema.parse({ type: "emote", emoji: "x" })).toBeDefined();
    expect(emoteSchema.parse({ type: "emote", emoji: "" })).toBeUndefined();
    expect(
      emoteSchema.parse({ type: "emote", emoji: "x".repeat(MAX_EMOJI_CHARS + 1) })
    ).toBeUndefined();
  });
});
