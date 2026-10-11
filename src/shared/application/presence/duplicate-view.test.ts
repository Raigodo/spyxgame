import { describe, expect, it, vi } from "vitest";
import { createConfig } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { DuplicateView } from "./duplicate-view";

const config = createConfig().presence;

function setup(present: string[] = []) {
  const clock = new FakeClock();
  const onReveal = vi.fn();
  const onChanged = vi.fn();
  const view = new DuplicateView({
    clock,
    config,
    isPresent: (id) => present.includes(id),
    getPresentPeerIds: () => new Set(present),
    onReveal,
    onChanged,
  });
  return { clock, view, onReveal, onChanged };
}

describe("DuplicateView", () => {
  it("hides the newcomer and shows the old peer as reconnecting while disputed", () => {
    const { view } = setup();
    view.register("p", "old", "new");
    expect(view.isHidden("new")).toBe(true);
    expect(view.isReconnecting("old")).toBe(true);
    expect(view.isHidden("old")).toBe(false);
  });

  it("reveals the newcomer when the old side leaves, and not when the newcomer leaves", () => {
    const a = setup();
    a.view.register("p", "old", "new");
    a.view.resolveDeparted("old");
    expect(a.onReveal).toHaveBeenCalledWith("new");
    expect(a.view.isHidden("new")).toBe(false);

    const b = setup();
    b.view.register("p", "old", "new");
    b.view.resolveDeparted("new");
    expect(b.onReveal).not.toHaveBeenCalled();
    expect(b.onChanged).toHaveBeenCalled();
  });

  it("survivorReplacing needs the old side gone and the newcomer present", () => {
    const { view } = setup(["new"]);
    view.register("p", "old", "new");
    expect(view.survivorReplacing("old")).toBe("new");
    expect(view.survivorReplacing("other")).toBeUndefined();
  });

  it("the safety timeout reveals a present newcomer and clears the dispute", () => {
    const { clock, view, onReveal } = setup(["new"]);
    view.register("p", "old", "new");
    clock.advance(config.duplicateRevealTimeoutMs);
    expect(onReveal).toHaveBeenCalledWith("new");
    expect(view.isHidden("new")).toBe(false);
  });

  it("registering the same player twice keeps the first pair", () => {
    const { view } = setup();
    view.register("p", "old", "new");
    view.register("p", "x", "y");
    expect(view.isHidden("y")).toBe(false);
  });
});
