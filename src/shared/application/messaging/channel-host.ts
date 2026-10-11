import type { BusTransport, CommandResult, PeerId } from "./types";
import type { Wire } from "./wire";

/** What channels need from the bus (not part of the public API). */
export interface ChannelHost {
  readonly transport: BusTransport;
  canPublish(): boolean;
  sendCommand(ch: string, type: string, payload: unknown): Promise<CommandResult>;
  broadcast(wire: Wire): void;
  sendTo(to: PeerId, wire: Wire): void;
  statusMayHaveChanged(): void;
}
