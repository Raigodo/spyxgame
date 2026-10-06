import type { SignalingPeerId } from "../signaling";

export type DeadLinkAction = "drop-stale" | "reconnect-as-host" | "reconnect-as-guest";

/**
 * What to do when an active link dies. A guest has one link that matters: the one to the host.
 * A dead link to anyone else is a stale leftover (e.g. the previous host after a handoff) and must
 * never be read as a dead host.
 */
export function decideDeadLinkAction(args: {
  isHost: boolean;
  peerId: SignalingPeerId;
  hostPeerId: SignalingPeerId | undefined;
}): DeadLinkAction {
  if (args.isHost) return "reconnect-as-host";
  return args.peerId === args.hostPeerId ? "reconnect-as-guest" : "drop-stale";
}
