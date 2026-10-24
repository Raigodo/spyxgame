import type { PeerId, PlayerId } from "@/kernel";
import type { LinkState } from "../model";

export type BindOutcome = "new" | "same" | "conflict";

/** A binding is final per peerId: a later hello claiming another playerId is a conflict and changes nothing. */
export function bindHello(
  bindings: ReadonlyMap<PeerId, PlayerId>,
  from: PeerId,
  playerId: PlayerId
): { outcome: BindOutcome; next: ReadonlyMap<PeerId, PlayerId> } {
  const existing = bindings.get(from);
  if (existing === undefined) {
    return { outcome: "new", next: new Map(bindings).set(from, playerId) };
  }
  return { outcome: existing === playerId ? "same" : "conflict", next: bindings };
}

/** Bindings of peers that are no longer members. Returns the same map when nothing was removed. */
export function pruneBindings(
  bindings: ReadonlyMap<PeerId, PlayerId>,
  isMember: (peerId: PeerId) => boolean
): ReadonlyMap<PeerId, PlayerId> {
  let next: Map<PeerId, PlayerId> | undefined;
  for (const peerId of bindings.keys()) {
    if (isMember(peerId)) continue;
    next ??= new Map(bindings);
    next.delete(peerId);
  }
  return next ?? bindings;
}

export function sameBindings(
  a: ReadonlyMap<PeerId, PlayerId>,
  b: ReadonlyMap<PeerId, PlayerId>
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, playerId] of a) if (b.get(id) !== playerId) return false;
  return true;
}

/** Peers with an active link, minus the excluded ones. */
export function activeTargets(
  links: ReadonlyMap<PeerId, LinkState>,
  exclude: readonly PeerId[]
): PeerId[] {
  const out: PeerId[] = [];
  for (const [peerId, state] of links) {
    if (state === "active" && !exclude.includes(peerId)) out.push(peerId);
  }
  return out;
}

export function fitsLimit(encoded: string, maxChars: number): boolean {
  return encoded.length <= maxChars;
}

/** A guest says hello when its link to the host is up and it has not said it for this host and this link. */
export function shouldAnnounce(a: {
  role: "guest" | "host";
  host: PeerId | undefined;
  hostLink: LinkState | undefined;
  announcedHost: PeerId | undefined;
  wasActive: boolean;
}): { announce: boolean; active: boolean } {
  const active = a.role === "guest" && a.host !== undefined && a.hostLink === "active";
  return { active, announce: active && (!a.wasActive || a.announcedHost !== a.host) };
}
