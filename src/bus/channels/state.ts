// Host-owned replicated value, versioned by (epoch, rev). Guests accept only newer versions from
// the current host. Changed only by commands (pure reducers); the host runs them exactly once per
// (sender, seq), and the `applied` marks are replicated in the same commit.

import {
  Cell,
  batch,
  fail,
  ok,
  type ChannelId,
  type Logger,
  type PeerId,
  type PlayerId,
  type Result,
  type Store,
} from "@/kernel";
import type { BusConfig } from "../config";
import type {
  BusFailure,
  BusReject,
  Cmd,
  CmdCtx,
  CommandSpec,
  PrivateWrite,
  StateDef,
  StateHandle,
} from "../model";
import { compareVersions, isDuplicateCommand, pruneApplied } from "../rules";
import type { BusMsgOf, ChannelCopy } from "../wire";
import type { ChannelHost } from "./host";

/** What the bus calls on a state channel, whatever its value type. */
export interface BusStateChannel {
  readonly id: ChannelId;
  readonly synced: Store<boolean>;
  isSynced(): boolean;
  markUnsynced(): void;
  copy(): ChannelCopy;
  /** Guest: a snapshot or update from the current host. */
  acceptState(c: ChannelCopy): void;
  /** Host, recovery: adopt the best offered copy. */
  adoptIfNewer(c: ChannelCopy): void;
  /** Host: start a new epoch and tell everyone. */
  promote(): void;
  sendSnapshot(to: PeerId): void;
  /** Host: apply a command exactly once per (sender, seq). */
  execute(from: PeerId, msg: BusMsgOf<"command">): Result<void, string>;
  /** Drops `applied` marks of peers no longer in the room. */
  pruneApplied(memberPeerIds: ReadonlySet<string>): void;
  attachPrivate(sink: PrivateSink): void;
}

/** The private channel that stores `privateWrites` of this state channel's commits. */
export interface PrivateSink {
  commit(writes: readonly PrivateWrite[]): void;
}

type ErasedSpec<S> = CommandSpec<S, unknown, string>;
type Planned<S> = { state: S; writes: readonly PrivateWrite[] };

export interface StateChannelDeps<S, C extends Cmd, R extends string> {
  host: ChannelHost;
  def: StateDef<S, C, R>;
  config: Pick<BusConfig, "maxStateChars">;
  log: Logger;
}

export class StateChannel<S, C extends Cmd, R extends string>
  implements StateHandle<S, C, R>, BusStateChannel
{
  readonly id: ChannelId;
  private readonly valueCell = new Cell<S | undefined>(undefined);
  private readonly syncedCell = new Cell(false);
  readonly value: Store<S | undefined> = this.valueCell;
  readonly synced: Store<boolean> = this.syncedCell;

  private state: S;
  private epoch = 0;
  private rev = 0;
  /** Host time of the last commit or adopted copy. */
  private asOf = 0;
  private applied: Readonly<Record<string, number>> = {};
  private privateSink?: PrivateSink;
  private readonly specs: ReadonlyMap<string, ErasedSpec<S>>;

  constructor(private readonly deps: StateChannelDeps<S, C, R>) {
    this.id = deps.def.id;
    this.state = deps.def.init;
    this.specs = new Map(Object.entries(deps.def.commands) as [string, ErasedSpec<S>][]);
  }

  // ─── Public handle ────────────────────────────────────────────────────────

  async send(cmd: C): Promise<Result<void, R | BusReject | BusFailure>> {
    const verdict = await this.deps.host.sendCommand(this.id, cmd.type, cmd);
    return verdict as Result<void, R | BusReject | BusFailure>;
  }

  apply(cmd: C): Result<void, R | BusReject | "not-ready"> {
    const { host } = this.deps;
    if (!host.canCommit() || !this.syncedCell.get()) return fail("not-ready");
    const spec = this.specs.get(cmd.type);
    if (!spec) return fail("unknown-command");
    const ctx = this.context(host.self, true, host.localPlayerId);
    const planned = this.evaluate(spec, cmd, ctx);
    if (!planned.ok) return fail(planned.reason as R | BusReject);
    if (planned.value) this.commit(planned.value);
    return ok();
  }

  // ─── Internal (used by the flow) ──────────────────────────────────────────

  isSynced(): boolean {
    return this.syncedCell.get();
  }

  markUnsynced(): void {
    this.syncedCell.set(false);
  }

  attachPrivate(sink: PrivateSink): void {
    if (this.privateSink) throw new Error(`[bus] "${this.id}" already has a private channel.`);
    this.privateSink = sink;
  }

  copy(): ChannelCopy {
    return {
      ch: this.id,
      epoch: this.epoch,
      rev: this.rev,
      asOf: this.asOf,
      value: this.state as ChannelCopy["value"],
      applied: { ...this.applied },
    };
  }

  acceptState(c: ChannelCopy): void {
    const value = this.deps.def.schema.parse(c.value);
    if (value === undefined) return;
    const order = compareVersions(c, this.version());
    if (order < 0) return; // stale or from a demoted host
    this.deps.host.observeHostTime(c.asOf);
    const known = this.valueCell.get() !== undefined;
    this.syncedCell.set(true);
    if (order === 0 && known) return; // identical version: just confirms we are in sync
    this.adopt(c, value);
  }

  adoptIfNewer(c: ChannelCopy): void {
    if (compareVersions(c, this.version()) <= 0) return;
    const value = this.deps.def.schema.parse(c.value);
    if (value !== undefined) this.adopt(c, value);
  }

  promote(): void {
    this.epoch += 1;
    this.rev = 0;
    this.asOf = this.deps.host.now();
    this.deps.host.broadcast(this.stateMsg());
    batch(() => {
      this.syncedCell.set(true);
      this.valueCell.set(this.state);
    });
  }

  sendSnapshot(to: PeerId): void {
    this.deps.host.sendTo(to, this.stateMsg());
  }

  execute(from: PeerId, msg: BusMsgOf<"command">): Result<void, string> {
    const { host } = this.deps;
    if (isDuplicateCommand(this.applied, from, msg.seq)) return ok(); // duplicate re-send

    const fromHost = from === host.self;
    const playerId = fromHost ? host.localPlayerId : host.playerOf(from);
    if (playerId === undefined) return fail("unknown-sender"); // not marked: no binding yet

    const spec = this.specs.get(msg.type);
    const planned = spec
      ? this.evaluate(spec, msg.payload, this.context(from, fromHost, playerId))
      : fail("unknown-command");

    this.applied = { ...this.applied, [from]: msg.seq }; // accepted or rejected, never re-run
    if (!planned.ok) return fail(planned.reason);
    if (planned.value) this.commit(planned.value); // applied is replicated in the same commit
    return ok();
  }

  pruneApplied(memberPeerIds: ReadonlySet<string>): void {
    this.applied = pruneApplied(this.applied, memberPeerIds);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private version(): { epoch: number; rev: number } {
    return { epoch: this.epoch, rev: this.rev };
  }

  private context(from: PeerId, fromHost: boolean, playerId: PlayerId): CmdCtx {
    return { from, fromHost, playerId, now: this.deps.host.now() };
  }

  /** Pure decision: what this command would do. `undefined` value: a no-op. */
  private evaluate(
    spec: ErasedSpec<S>,
    payload: unknown,
    ctx: CmdCtx
  ): Result<Planned<S> | undefined, string> {
    if (spec.who === "host" && !ctx.fromHost) return fail("host-only");
    const parsed = spec.schema.check(payload);
    if (!parsed.ok) return fail("invalid");

    let out: ReturnType<ErasedSpec<S>["reduce"]>;
    try {
      out = spec.reduce(this.state, parsed.value, ctx);
    } catch (error) {
      this.deps.log.error("Reducer threw", { ch: this.id, error }); // reducers must not throw
      return fail("invalid");
    }
    if (!out.ok) return fail(out.reason);

    const { state, privateWrites } = out.value;
    const writes = privateWrites ?? [];
    if (state === this.state && writes.length === 0) return ok(undefined); // no-op
    if (state !== this.state) {
      // Guarantee 9: a commit must not make state unsyncable.
      if (!this.deps.def.schema.check(state).ok) return fail("invalid");
      if (JSON.stringify(state).length > this.deps.config.maxStateChars) return fail("too-large");
    }
    return ok({ state, writes });
  }

  private commit(planned: Planned<S>): void {
    this.state = planned.state;
    this.rev += 1;
    this.asOf = this.deps.host.now();
    this.privateSink?.commit(planned.writes); // before the state that references them
    this.deps.host.broadcast(this.stateMsg());
    batch(() => {
      this.syncedCell.set(true);
      this.valueCell.set(this.state);
    });
  }

  private adopt(c: ChannelCopy, value: S): void {
    this.epoch = c.epoch;
    this.rev = c.rev;
    this.asOf = c.asOf;
    this.applied = { ...c.applied };
    this.state = value;
    if (this.syncedCell.get()) this.valueCell.set(value);
  }

  private stateMsg(): BusMsgOf<"state"> {
    return { kind: "state", ...this.copy() };
  }
}
