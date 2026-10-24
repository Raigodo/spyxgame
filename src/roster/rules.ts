// Pure decisions of the roster. No clock, no ids, no stores: everything arrives as an argument.
// The bus reducers in state.ts are thin wrappers around these functions.
// `peerId` in an entry always comes from the verified sender (`from`), never from a payload.

import { fail, ok, type PeerId, type PlayerId, type Result } from "@/kernel";
import type { Entry, Player, RosterLimits, RosterReject, RosterState } from "./model";

/** What the bus tells a reducer about the command's sender. */
export interface Actor {
  /** Verified sender peer. */
  from: PeerId;
  /** Verified sender player. */
  playerId: PlayerId;
  /** Continuous host time (ms). */
  now: number;
}

export type Outcome = Result<RosterState, RosterReject>;
export type LinkState = Entry["link"];
/** One key per member peer, as the host sees it. */
export type LinkMap = Readonly<Record<string, LinkState>>;

export const EMPTY_ROSTER: RosterState = { entries: {}, bans: [] };

const withEntry = (state: RosterState, id: string, entry: Entry): RosterState => ({
  ...state,
  entries: { ...state.entries, [id]: entry },
});

const withoutEntry = (state: RosterState, id: string): RosterState => {
  const { [id]: _removed, ...rest } = state.entries;
  return { ...state, entries: rest };
};

// ─── Commands ───────────────────────────────────────────────────────────────

export function applyJoin(
  state: RosterState,
  name: string,
  actor: Actor,
  limits: Pick<RosterLimits, "maxPlayers">
): Outcome {
  if (state.bans.includes(actor.playerId)) return fail("banned");

  const existing = state.entries[actor.playerId];
  if (!existing) {
    if (Object.keys(state.entries).length >= limits.maxPlayers) return fail("full");
    return ok(
      withEntry(state, actor.playerId, {
        name,
        joinedAt: actor.now,
        peerId: actor.from,
        link: "connecting",
      })
    );
  }

  // A repeated join from the peer that already holds the entry changes nothing.
  if (existing.peerId === actor.from && existing.goneAt === undefined) return ok(state);

  // Another peer holds it and its link is healthy: the host must arbitrate (ping), not take over.
  if (
    existing.peerId !== undefined &&
    existing.peerId !== actor.from &&
    existing.link === "active"
  ) {
    return fail("taken");
  }

  // Takeover: a ghost, a refresh whose old peer is not active any more, or the same peer again.
  // The stored name and joinedAt are kept.
  return ok(
    withEntry(state, actor.playerId, {
      name: existing.name,
      joinedAt: existing.joinedAt,
      peerId: actor.from,
      link: "connecting",
    })
  );
}

export function applyRename(state: RosterState, name: string, actor: Actor): Outcome {
  const entry = state.entries[actor.playerId];
  if (!entry) return fail("unknown-player");
  if (entry.name === name) return ok(state);
  return ok(withEntry(state, actor.playerId, { ...entry, name }));
}

/**
 * Host-only (`who: "host"`), so `actor.from` is the host's own peer: its entry stays online
 * (transport `members` excludes self). `links` has one key per member peer.
 */
export function applySync(
  state: RosterState,
  links: LinkMap,
  actor: Pick<Actor, "from" | "now">,
  departureGraceMs: number
): RosterState {
  let next: Record<string, Entry> | undefined;
  for (const [id, entry] of Object.entries(state.entries)) {
    const updated = syncEntry(entry, links, actor, departureGraceMs);
    if (updated === entry) continue;
    next ??= { ...state.entries };
    if (updated) next[id] = updated;
    else delete next[id];
  }
  return next ? { ...state, entries: next } : state;
}

function syncEntry(
  entry: Entry,
  links: LinkMap,
  actor: Pick<Actor, "from" | "now">,
  graceMs: number
): Entry | undefined {
  // Already a ghost: expire it once its grace ran out.
  if (entry.peerId === undefined) {
    if (entry.goneAt === undefined) return { ...entry, goneAt: actor.now };
    return actor.now - entry.goneAt >= graceMs ? undefined : entry;
  }

  const link: LinkState | undefined = entry.peerId === actor.from ? "active" : links[entry.peerId];

  // Its peer left membership: keep the row as a ghost (a refresh is one row going reconnecting).
  if (link === undefined) {
    return { name: entry.name, joinedAt: entry.joinedAt, link: "reconnecting", goneAt: actor.now };
  }

  if (entry.link === link && entry.goneAt === undefined) return entry;
  return { name: entry.name, joinedAt: entry.joinedAt, peerId: entry.peerId, link };
}

export function applyRemove(state: RosterState, target: PlayerId, actor: Actor): Outcome {
  if (target === actor.playerId) return fail("cannot-target-self");
  if (!state.entries[target]) return fail("unknown-player");
  return ok(withoutEntry(state, target));
}

export function applyBan(
  state: RosterState,
  target: PlayerId,
  actor: Actor,
  limits: Pick<RosterLimits, "banLimit">
): Outcome {
  if (target === actor.playerId) return fail("cannot-target-self");
  const withoutTarget = state.entries[target] ? withoutEntry(state, target) : state;
  if (withoutTarget.bans.includes(target)) return ok(withoutTarget);
  // Newest bans win when the list is full.
  const bans = [...withoutTarget.bans, target].slice(-limits.banLimit);
  return ok({ ...withoutTarget, bans });
}

export function applyUnban(state: RosterState, target: PlayerId): Outcome {
  if (!state.bans.includes(target)) return fail("unknown-player");
  return ok({ ...state, bans: state.bans.filter((id) => id !== target) });
}

// ─── Projections ────────────────────────────────────────────────────────────

/** Who is who right now, from the local point of view. */
export interface Viewpoint {
  selfPeerId: PeerId;
  /** undefined while there is no host. */
  hostPeerId: PeerId | undefined;
}

/** Join order (then id), ghosts included. Presence overlays the local peer as "self". */
export function entriesToPlayers(state: RosterState, view: Viewpoint): Player[] {
  const players: Player[] = Object.entries(state.entries).map(([id, entry]) => {
    const { peerId } = entry;
    const presence: Player["presence"] =
      peerId === undefined
        ? "reconnecting"
        : peerId === view.selfPeerId
          ? "self"
          : entry.link === "active"
            ? "online"
            : entry.link;
    return {
      id: id as PlayerId,
      name: entry.name,
      ...(peerId !== undefined ? { peerId } : {}),
      presence,
      isHost: peerId !== undefined && peerId === view.hostPeerId,
      joinedAt: entry.joinedAt,
    };
  });
  return players.sort(
    (a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Host time at which the next ghost expires, or undefined when there are no ghosts. */
export function nextGhostExpiry(state: RosterState, departureGraceMs: number): number | undefined {
  let earliest: number | undefined;
  for (const entry of Object.values(state.entries)) {
    if (entry.peerId !== undefined || entry.goneAt === undefined) continue;
    const at = entry.goneAt + departureGraceMs;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}
