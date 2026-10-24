// What channels need from the bus (not public). The flow implements it over Transport and the
// bus's own state; tests implement it with a few lines.

import type { PeerId, PlayerId, Store } from "@/kernel";
import type { Verdict } from "../queue";
import type { BusMsg } from "../wire";

export interface ChannelHost {
  readonly self: PeerId;
  readonly localPlayerId: PlayerId;
  readonly role: Store<"guest" | "host">;
  /** This peer is the host. */
  isHost(): boolean;
  /** Host and not recovering: commands may run and state may be published. */
  canCommit(): boolean;
  /** Continuous host time (`bus.now()`). */
  now(): number;
  /** A guest saw a state copy stamped with host time `asOf`. */
  observeHostTime(asOf: number): void;
  broadcast(msg: BusMsg): void;
  sendTo(to: PeerId, msg: BusMsg): void;
  /** Sender side: queue a command for the host. */
  sendCommand(ch: string, type: string, payload: unknown): Promise<Verdict>;
  /** Host side: the durable player behind a verified peer (`undefined`: no hello yet). */
  playerOf(peer: PeerId): PlayerId | undefined;
  /** Host side: where a player's data goes now (`undefined`: not a member). */
  peerOf(player: PlayerId): PeerId | undefined;
  linkActive(peer: PeerId): boolean;
}
