// The roster's public types, schemas and API. Contract: docs/rewrite/zoom-4-roster-client.md.
// Changes vs the doc (own layer): `Roster.events.refused` (the guest was refused: banned or full,
// the room ends on it) and `rename` may also reject `unknown-player`.

import {
  s,
  type Clock,
  type IdGenerator,
  type Infer,
  type Listenable,
  type Logger,
  type PeerId,
  type PlayerId,
  type Result,
  type Storages,
  type Store,
} from "@/kernel";
import type { Bus, BusFailure } from "@/bus";
import type { HandOffReject, Transport } from "@/transport";
import type { RosterConfig } from "./config";
import { EVENT, MAX_NONCE_CHARS } from "./names";

// ─── Replicated data ────────────────────────────────────────────────────────

export interface RosterLimits {
  maxPlayers: number;
  maxNameLength: number;
  banLimit: number;
}

/** Network input: every shape that crosses the bus. Limits come from RosterConfig. */
export function createRosterSchemas(limits: RosterLimits) {
  const link = s.oneOf(["connecting", "active", "reconnecting"] as const);
  const name = s.string({ min: 1, max: limits.maxNameLength });
  const entry = s.object({
    name,
    joinedAt: s.number(),
    /** undefined: a ghost (the peer left membership). */
    peerId: s.optional(s.id("peer")),
    link,
    /** Host time when the entry became a ghost. */
    goneAt: s.optional(s.number()),
  });
  const target = { playerId: s.id("player") };

  return {
    state: s.object({
      entries: s.record(entry, { maxKeys: limits.maxPlayers, onInvalid: "reject" }),
      bans: s.list(s.id("player"), { max: limits.banLimit, onInvalid: "drop" }),
    }),
    commands: {
      join: s.object({ type: s.literal("join"), name }),
      rename: s.object({ type: s.literal("rename"), name }),
      // One key per current member peer; at most twice the capacity (the host caps what it sends).
      sync: s.object({
        type: s.literal("sync"),
        links: s.record(link, { maxKeys: limits.maxPlayers * 2, onInvalid: "reject" }),
      }),
      remove: s.object({ type: s.literal("remove"), ...target }),
      ban: s.object({ type: s.literal("ban"), ...target }),
      unban: s.object({ type: s.literal("unban"), ...target }),
    },
    event: s.tagged("kind", {
      [EVENT.ping]: s.object({ nonce: s.string({ min: 1, max: MAX_NONCE_CHARS }) }),
      [EVENT.pong]: s.object({ nonce: s.string({ min: 1, max: MAX_NONCE_CHARS }) }),
    }),
  };
}

type Schemas = ReturnType<typeof createRosterSchemas>;

export type RosterState = Infer<Schemas["state"]>;
export type Entry = RosterState["entries"][string];
export type RosterCommand =
  | Infer<Schemas["commands"]["join"]>
  | Infer<Schemas["commands"]["rename"]>
  | Infer<Schemas["commands"]["sync"]>
  | Infer<Schemas["commands"]["remove"]>
  | Infer<Schemas["commands"]["ban"]>
  | Infer<Schemas["commands"]["unban"]>;
export type RosterEvent = Infer<Schemas["event"]>;

/** Reasons the roster reducers return (the bus adds `invalid`, `too-large` and its own). */
export type RosterReject =
  "taken" | "banned" | "full" | "invalid" | "unknown-player" | "cannot-target-self";

// ─── Public API ─────────────────────────────────────────────────────────────

export type Presence = "self" | "online" | "connecting" | "reconnecting";

export interface Player {
  id: PlayerId;
  name: string;
  /** undefined: a ghost row. */
  peerId?: PeerId;
  presence: Presence;
  isHost: boolean;
  joinedAt: number;
}

export type TargetReject = "not-host" | "not-ready" | "unknown-player" | "cannot-target-self";

/** Why this peer was refused admission. The room ends on it. */
export type RefusalReason = "banned" | "full";

export interface Roster {
  state: {
    /** Join order, ghosts included. */
    players: Store<readonly Player[]>;
    /** undefined until admitted. */
    me: Store<Player | undefined>;
    host: Store<Player | undefined>;
    bans: Store<ReadonlySet<PlayerId>>;
  };
  actions: {
    /** Saves the nickname to the profile store on success. */
    rename(name: string): Promise<Result<void, "invalid" | "unknown-player" | BusFailure>>;
    /** Host only. */
    kick(id: PlayerId): Promise<Result<void, TargetReject>>;
    ban(id: PlayerId): Promise<Result<void, TargetReject>>;
    unban(id: PlayerId): Promise<Result<void, TargetReject>>;
    handOff(id: PlayerId): Promise<Result<void, TargetReject | HandOffReject>>;
  };
  events: {
    joined: Listenable<Player>;
    rejoined: Listenable<Player>;
    /** `removed`: kick or ban. `expired`: a ghost's grace ran out. */
    left: Listenable<{ player: Player; reason: "expired" | "removed" }>;
    refused: Listenable<RefusalReason>;
  };
}

export interface RosterDeps {
  transport: Transport;
  /** Register channels before `bus.start()`: createRoster does it. */
  bus: Bus;
  localPlayerId: PlayerId;
  /** Falls back to the stored nickname, then `config.defaultName`. */
  nickname?: string;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  storages: Pick<Storages, "profile">;
  config: RosterConfig;
}
