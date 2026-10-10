import { describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "./console-logger";
import { parseScopeLevels } from "./log-levels";

describe("ConsoleLogger", () => {
  it("a scope override lowers the threshold for that subtree only", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = new ConsoleLogger("mp", "warn", parseScopeLevels("bus:debug"));
    root.child("bus").debug("shown");
    root.child("webrtc").debug("hidden");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[mp:bus] shown");
  });
  it("an override can also raise the threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new ConsoleLogger("mp:webrtc", "debug", parseScopeLevels("webrtc:error")).warn("hidden");
    expect(warn).not.toHaveBeenCalled();
  });
  it("passes data through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new ConsoleLogger("mp", "debug", parseScopeLevels(undefined)).warn("m", { a: 1 });
    expect(warn).toHaveBeenCalledWith("[mp] m", { a: 1 });
  });
});
