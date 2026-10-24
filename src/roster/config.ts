import { defineConfig, limit, resolveConfig, timer, value, type ConfigValues } from "@/kernel";

export const rosterConfig = defineConfig("roster", {
  maxPlayers: limit(32, {
    why: "Room capacity. Bounds every per-player map and the whole-state broadcast.",
  }),
  maxNameLength: limit(32, { why: "Longest accepted nickname (characters)." }),
  banLimit: limit(100, { why: "Newest bans kept in the replicated roster state." }),
  defaultName: value("Player", "Nickname used when none was given and none is stored."),
  departureGraceMs: timer(4_000, {
    why: "A refreshing player's row stays as a ghost this long, so a reload is one row going reconnecting then online.",
  }),
  pingTimeoutMs: timer(2_000, {
    why: "Duplicate-tab check: no pong in this time means the old tab is a ghost and is dropped.",
    destructive: true,
  }),
  linkWaitMs: timer(8_000, {
    why: "After a promotion, arbitration waits this long for links to become active before pinging.",
  }),
  joinRetryMs: timer(3_000, {
    why: "A guest repeats `join` until the synced roster holds its entry (a lost command heals itself).",
  }),
  profileTtlMs: timer(24 * 60 * 60 * 1000, {
    why: "How long the remembered nickname survives in the browser.",
  }),
});

export type RosterConfig = ConfigValues<typeof rosterConfig>;

export const DEFAULT_ROSTER_CONFIG: RosterConfig = resolveConfig(rosterConfig);
