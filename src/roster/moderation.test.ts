import { describe, expect, it } from "vitest";
import { toTargetReject } from "./moderation";

describe("toTargetReject", () => {
  it("passes the target reasons through", () => {
    for (const r of ["unknown-player", "cannot-target-self", "not-ready"]) {
      expect(toTargetReject(r)).toBe(r);
    }
  });
  it("host-only becomes not-host; anything else is unknown-player", () => {
    expect(toTargetReject("host-only")).toBe("not-host");
    expect(toTargetReject("invalid")).toBe("unknown-player");
  });
});
