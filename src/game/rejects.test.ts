import { describe, expect, it } from "vitest";
import { toContinueReject, toEndReject, toStartReject } from "./rejects";

describe("toStartReject", () => {
  it("passes the start reasons through", () => {
    for (const r of [
      "not-host",
      "not-ready",
      "already-playing",
      "unknown-game",
      "unsupported-mode",
      "too-few-players",
      "too-many-players",
      "invalid-settings",
    ]) {
      expect(toStartReject(r)).toBe(r);
    }
  });
  it("host-only is not-host; anything else is invalid-settings", () => {
    expect(toStartReject("host-only")).toBe("not-host");
    for (const r of ["invalid", "too-large", "invalid-private"])
      expect(toStartReject(r)).toBe("invalid-settings");
  });
});

describe("toEndReject / toContinueReject", () => {
  it("map not-ready and host-only, default to the state reason", () => {
    expect(toEndReject("not-ready")).toBe("not-ready");
    expect(toEndReject("host-only")).toBe("not-host");
    expect(toEndReject("not-playing")).toBe("not-playing");
    expect(toContinueReject("not-ready")).toBe("not-ready");
    expect(toContinueReject("host-only")).toBe("not-host");
    expect(toContinueReject("no-active-game")).toBe("not-paused");
    expect(toContinueReject("not-paused")).toBe("not-paused");
  });
});
