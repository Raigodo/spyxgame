export { createRoster } from "./create-roster";
export { DEFAULT_ROSTER_CONFIG, rosterConfig } from "./config";
export type { RosterConfig } from "./config";
export { openProfile } from "./profile-store";
export type { ProfileStore } from "./profile-store";
export type {
  Player,
  Presence,
  RefusalReason,
  Roster,
  RosterDeps,
  RosterReject,
  TargetReject,
} from "./model";
// fakes.ts is imported directly by tests ("@/roster/fakes"), never through this barrel.
