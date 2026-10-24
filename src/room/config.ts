import { resolveConfig } from "@/kernel";
import { DEFAULT_BUS_CONFIG, type BusConfig } from "@/bus";
import { DEFAULT_ROSTER_CONFIG, type RosterConfig } from "@/roster";
import { linkConfig, signalingConfig, type LinkConfig, type SignalingConfig } from "@/transport";

/** One section per layer; each layer receives only its own. */
export interface RoomConfig {
  signaling: SignalingConfig;
  link: LinkConfig;
  bus: BusConfig;
  roster: RosterConfig;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  signaling: resolveConfig(signalingConfig),
  link: resolveConfig(linkConfig),
  bus: DEFAULT_BUS_CONFIG,
  roster: DEFAULT_ROSTER_CONFIG,
};
