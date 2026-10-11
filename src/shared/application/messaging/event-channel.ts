import { Emitter } from "@/shared/kernel";
import type { ChannelHost } from "./channel-host";
import type { EventChannelOptions, PeerId } from "./types";

/** What the bus calls on an event channel, whatever its event type. */
export interface BusEventChannel {
  readonly id: string;
  receive(raw: unknown, from: PeerId): void;
}

// Ephemeral: no versioning, no replay. Delivered locally to the sender too,
// so callers don't need to special-case their own messages.
export class EventChannel<E> implements BusEventChannel {
  private readonly received = new Emitter<{ event: E; from: PeerId }>();

  /** @internal use RoomBus.eventChannel() */
  constructor(
    private readonly host: ChannelHost,
    readonly id: string,
    private readonly opts: EventChannelOptions<E>
  ) {}

  onEvent(handler: (event: E, from: PeerId) => void): () => void {
    return this.received.on(({ event, from }) => handler(event, from));
  }

  broadcast(event: E): void {
    this.host.broadcast({ __bus: 1, kind: "event", ch: this.id, event });
    this.deliverLocal(event);
  }

  sendTo(peerId: PeerId, event: E): void {
    if (peerId === this.host.transport.getLocalPeerId()) return this.deliverLocal(event);
    this.host.sendTo(peerId, { __bus: 1, kind: "event", ch: this.id, event });
  }

  /** @internal */
  receive(raw: unknown, from: PeerId): void {
    const event = this.opts.validate(raw);
    if (event !== undefined) this.received.emit({ event, from });
  }

  private deliverLocal(event: E): void {
    const from = this.host.transport.getLocalPeerId();
    if (from) this.received.emit({ event, from });
  }
}
