import type { PeerId } from "@/kernel";
import type { LinkState, Member } from "./model";

type Links = ReadonlyMap<PeerId, LinkState>;
type Members = ReadonlyMap<PeerId, Member>;

const NO_LINKS: Links = new Map();

/** Host: every link. Guest: only the link to the host. */
export function narrowLinks(role: "guest" | "host", host: PeerId | undefined, links: Links): Links {
  if (role === "host") return links;
  const state = host === undefined ? undefined : links.get(host);
  return host !== undefined && state !== undefined ? new Map([[host, state]]) : NO_LINKS;
}

export function sameLinks(a: Links, b: Links): boolean {
  if (a.size !== b.size) return false;
  for (const [id, state] of a) if (b.get(id) !== state) return false;
  return true;
}

/** Host side: attaches the verified playerId. A guest knows no bindings, so members pass through. */
export function composeMembers(
  role: "guest" | "host",
  members: Members,
  bindings: ReadonlyMap<PeerId, string>
): Members {
  if (role !== "host") return members;
  const out = new Map<PeerId, Member>();
  for (const [id, member] of members) {
    const playerId = bindings.get(id);
    out.set(id, playerId === undefined ? member : ({ ...member, playerId } as Member));
  }
  return out;
}

export function sameMembers(a: Members, b: Members): boolean {
  if (a.size !== b.size) return false;
  for (const [id, m] of a) {
    const other = b.get(id);
    if (!other || other.joinedAt !== m.joinedAt || other.playerId !== m.playerId) return false;
  }
  return true;
}
