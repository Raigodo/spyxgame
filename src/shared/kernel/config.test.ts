import { describe, expect, it } from "vitest";
import { createConfig, DEFAULT_CONFIG } from "./config";

describe("createConfig", () => {
  it("returns defaults for every section", () => {
    expect(createConfig()).toEqual(DEFAULT_CONFIG);
  });
  it("merges one field and keeps the rest of the section", () => {
    const c = createConfig({ signaling: { positionIntervalMs: 10 } });
    expect(c.signaling.positionIntervalMs).toBe(10);
    expect(c.signaling.ackTimeoutMs).toBe(DEFAULT_CONFIG.signaling.ackTimeoutMs);
  });
  it("does not mutate DEFAULT_CONFIG", () => {
    createConfig({ chat: { burst: 1 } });
    expect(DEFAULT_CONFIG.chat.burst).toBe(30);
  });
});
