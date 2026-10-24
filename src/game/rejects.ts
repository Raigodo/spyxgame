// Maps what `StateHandle.apply` can answer onto the closed reject unions of the public actions.
// A guest's `apply` answers "not-ready", so callers check the role first and answer "not-host".

import type { ContinueReject, EndReject, StartReject } from "./model";

const START: ReadonlySet<string> = new Set<StartReject>([
  "not-host",
  "not-ready",
  "already-playing",
  "unknown-game",
  "unsupported-mode",
  "too-few-players",
  "too-many-players",
  "invalid-settings",
]);

export function toStartReject(reason: string): StartReject {
  if (START.has(reason)) return reason as StartReject;
  if (reason === "host-only") return "not-host";
  // "invalid", "too-large" (a start that would break a cap) and "invalid-private": the settings.
  return "invalid-settings";
}

export function toEndReject(reason: string): EndReject {
  if (reason === "not-ready") return "not-ready";
  if (reason === "host-only") return "not-host";
  return "not-playing";
}

export function toContinueReject(reason: string): ContinueReject {
  if (reason === "not-ready") return "not-ready";
  if (reason === "host-only") return "not-host";
  return "not-paused"; // "not-paused" and "no-active-game"
}
