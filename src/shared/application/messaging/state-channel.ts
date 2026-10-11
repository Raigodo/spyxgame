import { Emitter } from "@/shared/kernel";
import { compareVersions, isDuplicateCommand } from "./bus-rules";
import type { ChannelHost } from "./channel-host";
import type { CommandResult, CommandSpec, PeerId, StateChannelOptions } from "./types";
import type { ChannelCopy, Wire } from "./wire";

type ErasedHandler<S> = (args: {
  from: PeerId;
  isHostSender: boolean;
  state: S;
  payload: unknown;
  playerId?: string;
}) => { ok: true; state: S } | { ok: false; reason: string };

/** What the bus calls on a channel, whatever its value type. */
export interface BusStateChannel {
  readonly id: string;
  isSynced(): boolean;
  markUnsynced(): void;
  copy(): ChannelCopy;
  acceptState(c: ChannelCopy): void;
  adoptIfNewer(c: ChannelCopy): void;
  promote(): void;
  sendSnapshot(to: PeerId): void;
  execute(from: PeerId, seq: number, type: string, payload: unknown): CommandResult;
  inspect(): Record<string, unknown>;
}

// Host-owned replicated value, versioned by (epoch, rev). Guests accept only
// newer versions from the current host. Mutated on the host through commands
// (pure reducers) or publish().
export class StateChannel<S> implements BusStateChannel {
  private epoch = 0;
  private rev = 0;
  private value: S;
  private applied: Record<PeerId, number> = {};
  private synced = false;
  private readonly changed = new Emitter<{ value: S; prev: S }>();
  private readonly handlers = new Map<string, ErasedHandler<S>>();

  /** @internal use RoomBus.stateChannel() */
  constructor(
    private readonly host: ChannelHost,
    readonly id: string,
    private readonly opts: StateChannelOptions<S>
  ) {
    this.value = opts.initial;
  }

  get(): S {
    return this.value;
  }

  onChange(handler: (value: S, prev: S) => void): () => void {
    return this.changed.on(({ value, prev }) => handler(value, prev));
  }

  /** Registers a command type. Handlers run on whichever peer is host. */
  handle<P>(type: string, spec: CommandSpec<S, P>): void {
    this.handlers.set(type, ({ from, isHostSender, state, payload, playerId }) => {
      if (spec.hostOnly && !isHostSender) return { ok: false, reason: "host-only" };
      const parsed = spec.validate(payload);
      if (parsed === undefined) return { ok: false, reason: "invalid-payload" };
      const denied = spec.authorize?.({ from, state, isHostSender, playerId });
      if (denied) return { ok: false, reason: denied };
      return spec.reduce(state, parsed, { from, playerId });
    });
  }

  send<P>(type: string, payload: P): Promise<CommandResult> {
    return this.host.sendCommand(this.id, type, payload);
  }

  /** Host only. Prefer commands; publish() is for host-originated changes. */
  publish(next: S): void {
    if (!this.host.canPublish()) {
      throw new Error(`[StateChannel:${this.id}] publish() requires a ready host.`);
    }
    this.commit(next);
  }

  // ── internal (used by RoomBus) ──

  /** @internal */ isSynced(): boolean {
    return this.synced;
  }
  /** @internal */ markUnsynced(): void {
    this.synced = false;
  }

  /** @internal Values are left out on purpose: they can be large. */
  inspect(): Record<string, unknown> {
    return {
      epoch: this.epoch,
      rev: this.rev,
      synced: this.synced,
      applied: { ...this.applied },
      commands: Array.from(this.handlers.keys()),
    };
  }

  /** @internal */
  copy(): ChannelCopy {
    return {
      ch: this.id,
      epoch: this.epoch,
      rev: this.rev,
      value: this.value,
      applied: { ...this.applied },
    };
  }

  /** @internal Guest: accept a snapshot/update from the current host. */
  acceptState(c: ChannelCopy): void {
    const value = this.opts.validate(c.value);
    if (value === undefined) return;
    const order = compareVersions(c, this.version());
    if (order < 0) return; // stale or from a demoted host
    this.synced = true;
    if (order === 0) return; // identical version: just confirms we are in sync
    this.adopt(c, value);
  }

  /** @internal Host: adopt the best offered copy during recovery. */
  adoptIfNewer(c: ChannelCopy): void {
    if (compareVersions(c, this.version()) <= 0) return;
    const value = this.opts.validate(c.value);
    if (value !== undefined) this.adopt(c, value);
  }

  /** @internal Host: start a new epoch and tell everyone. */
  promote(): void {
    this.epoch += 1;
    this.rev = 0;
    this.synced = true;
    this.host.broadcast(this.stateWire());
  }

  /** @internal */
  sendSnapshot(to: PeerId): void {
    this.host.sendTo(to, this.stateWire());
  }

  /** @internal Host: apply a command exactly once per (sender, seq). */
  execute(from: PeerId, seq: number, type: string, payload: unknown): CommandResult {
    if (isDuplicateCommand(this.applied, from, seq)) return { ok: true }; // duplicate re-send

    const handler = this.handlers.get(type);
    const out: ReturnType<ErasedHandler<S>> = handler
      ? handler({
          from,
          isHostSender: from === this.host.transport.getLocalPeerId(),
          state: this.value,
          payload,
          playerId: this.opts.resolveSender?.(from),
        })
      : { ok: false, reason: "unknown-command" };

    this.applied[from] = seq; // accepted or rejected, never re-run
    if (!out.ok) return { ok: false, kind: "rejected", reason: out.reason };

    this.commit(out.state); // applied[] is replicated in the same commit
    return { ok: true };
  }

  private version(): { epoch: number; rev: number } {
    return { epoch: this.epoch, rev: this.rev };
  }

  private commit(next: S): void {
    const prev = this.value;
    this.value = next;
    this.rev += 1;
    this.synced = true;
    this.host.broadcast(this.stateWire());
    this.emit(next, prev);
  }

  private adopt(c: ChannelCopy, value: S): void {
    const prev = this.value;
    this.epoch = c.epoch;
    this.rev = c.rev;
    this.applied = { ...c.applied };
    this.value = value;
    this.emit(value, prev);
  }

  private emit(value: S, prev: S): void {
    this.changed.emit({ value, prev });
  }

  private stateWire(): Wire {
    return { __bus: 1, kind: "state", ...this.copy() };
  }
}
