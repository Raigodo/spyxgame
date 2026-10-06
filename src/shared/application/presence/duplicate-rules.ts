import type { SignalingPeerId } from "@/shared/infrastructure/signaling";

interface ProfileLike {
  peerId: SignalingPeerId;
  metadata: Record<string, unknown>;
}

export function readPlayerId(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.playerId === "string" ? metadata.playerId : undefined;
}

export interface DuplicateGroup {
  playerId: string;
  /** Directory order is join order for peers we heard about, so the last remote entry is the newcomer. */
  newcomerPeerId: SignalingPeerId;
  /** Every remote peer in the group; their links must be up before anyone is pinged. */
  involvedPeerIds: SignalingPeerId[];
}

/** playerIds present more than once. One pair per group; the local peer is never the newcomer. */
export function findDuplicateGroups(
  profiles: readonly ProfileLike[],
  localPeerId: SignalingPeerId | undefined
): DuplicateGroup[] {
  const groups = new Map<string, ProfileLike[]>();
  for (const profile of profiles) {
    const playerId = readPlayerId(profile.metadata);
    if (playerId) groups.set(playerId, [...(groups.get(playerId) ?? []), profile]);
  }

  const result: DuplicateGroup[] = [];
  for (const [playerId, group] of groups) {
    if (group.length < 2) continue;
    const newcomer = [...group].reverse().find((p) => p.peerId !== localPeerId);
    if (!newcomer) continue;
    result.push({
      playerId,
      newcomerPeerId: newcomer.peerId,
      involvedPeerIds: group.map((p) => p.peerId).filter((id) => id !== localPeerId),
    });
  }
  return result;
}

/** The already-present holder of the newcomer's playerId, if any. */
export function findExistingDuplicate<P extends ProfileLike>(
  profiles: readonly P[],
  newcomer: ProfileLike,
  playerId: string
): P | undefined {
  return profiles.find(
    (p) => p.peerId !== newcomer.peerId && readPlayerId(p.metadata) === playerId
  );
}

export type ArbitrationPlan = "reject-newcomer" | "ping-existing";

/** The host's own tab is trivially alive, so no ping is needed; anyone else gets a liveness check. */
export function planArbitration(
  existingPeerId: SignalingPeerId,
  localPeerId: SignalingPeerId | undefined
): ArbitrationPlan {
  return existingPeerId === localPeerId ? "reject-newcomer" : "ping-existing";
}

/** The newcomer's peerId if `departedPeerId` was the old side of a disputed pair and the newcomer is still present. */
export function findSurvivor(
  duplicates: Iterable<{ oldPeerId: SignalingPeerId; newPeerId: SignalingPeerId }>,
  departedPeerId: SignalingPeerId,
  presentPeerIds: ReadonlySet<SignalingPeerId>
): SignalingPeerId | undefined {
  for (const duplicate of duplicates) {
    if (duplicate.oldPeerId !== departedPeerId) continue;
    return presentPeerIds.has(duplicate.newPeerId) ? duplicate.newPeerId : undefined;
  }
  return undefined;
}
