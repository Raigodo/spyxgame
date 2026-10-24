// Ephemeral: no versioning, no replay. Delivered locally to the sender too (the transport never
// echoes), so callers don't need to special-case their own messages.

import { Emitter, type ChannelId, type Listenable, type PeerId } from "@/kernel";
import type { EventDef, EventHandle } from "../model";
import type { BusMsgOf } from "../wire";
import type { ChannelHost } from "./host";

/** What the bus calls on an event channel, whatever its event type. */
export interface BusEventChannel {
  readonly id: ChannelId;
  receive(from: PeerId, raw: unknown): void;
}

export class EventChannel<E> implements EventHandle<E>, BusEventChannel {
  private readonly received = new Emitter<{ event: E; from: PeerId }>();
  readonly events: Listenable<{ event: E; from: PeerId }> = this.received;
  readonly id: ChannelId;

  constructor(private readonly deps: { host: ChannelHost; def: EventDef<E> }) {
    this.id = deps.def.id;
  }

  broadcast(event: E): void {
    this.deps.host.broadcast(this.msg(event));
    this.received.emit({ event, from: this.deps.host.self });
  }

  sendTo(peer: PeerId, event: E): void {
    if (peer === this.deps.host.self) {
      this.received.emit({ event, from: peer });
      return;
    }
    this.deps.host.sendTo(peer, this.msg(event));
  }

  receive(from: PeerId, raw: unknown): void {
    const event = this.deps.def.schema.parse(raw);
    if (event !== undefined) this.received.emit({ event, from });
  }

  private msg(event: E): BusMsgOf<"event"> {
    return { kind: "event", ch: this.id, event: event as BusMsgOf<"event">["event"] };
  }
}
