import { expect, it } from "vitest";
import { installDebugHook, type DebugTarget } from "./debug-hook";

it("exposes the snapshot and removes only its own hook", () => {
  const target: DebugTarget = {};
  const off = installDebugHook({ getDebugState: () => ({ a: 1 }) }, target);
  expect(target.__room?.()).toEqual({ a: 1 });

  const replacement = () => ({ b: 2 });
  target.__room = replacement;
  off();
  expect(target.__room).toBe(replacement);
});

it("removes the hook when it is still installed", () => {
  const target: DebugTarget = {};
  const off = installDebugHook({ getDebugState: () => ({}) }, target);
  off();
  expect(target.__room).toBeUndefined();
});
