// The bus's public types. Features give the bus schemas and pure reducers; the bus never looks
// inside a payload. Contract: docs/rewrite/zoom-3-bus.md.

import type {
  ChannelId,
  Clock,
  IdGenerator,
  Listenable,
  Logger,
  PeerId,
  PlayerId,
  Result,
  Schema,
  Store,
} from "@/kernel";
import type { Transport } from "@/transport";
import type { BusConfig } from "./config";

export type BusSync = "lost" | "syncing" | "ready";

/** `send` resolved without a verdict: no ack before the TTL, or the bus was disposed first. */
export type BusFailure = "expired" | "left";

/** Rejections the bus itself produces, whatever the feature's own reasons are. */
export type BusReject =
  "invalid" | "too-large" | "unknown-sender" | "host-only" | "unknown-command";

export type Cmd = { type: string };

export type CmdCtx = {
  /** Host-verified sender. */
  from: PeerId;
  fromHost: boolean;
  /** Durable id bound to `from` by the transport's hello (host side only). */
  playerId?: PlayerId;
  /** Continuous host time (survives failover). */
  now: number;
};

/** A change to one player's private piece. `value: null` removes it. Revisions come from the game's slot. */
export type PrivateWrite = {
  playerId: PlayerId;
  round: number;
  rev: number;
  value: unknown | null;
};

export interface CommandSpec<S, P, R extends string> {
  who: "anyone" | "host";
  /** Payload schema, validated on the host. */
  schema: Schema<P>;
  /** Pure. Returning the same state reference is a no-op (no rev bump, no broadcast). */
  reduce(
    state: S,
    payload: P,
    ctx: CmdCtx
  ): Result<{ state: S; privateWrites?: readonly PrivateWrite[] }, R | "invalid" | "too-large">;
}

export interface StateDef<S, C extends Cmd, R extends string> {
  id: ChannelId;
  schema: Schema<S>;
  /** The host's starting value only. Never exposed as `value` before the first sync. */
  init: S;
  /** A new command type does not compile without a handler. */
  commands: { [K in C["type"]]: CommandSpec<S, Extract<C, { type: K }>, R> };
}

export interface StateHandle<S, C extends Cmd, R extends string> {
  /** undefined until first synced this session. */
  readonly value: Store<S | undefined>;
  readonly synced: Store<boolean>;
  /** Any peer. Queued, exactly once, resolves on the host's verdict. */
  send(cmd: C): Promise<Result<void, R | BusReject | BusFailure>>;
  /** Host only. Synchronous, same reducer, not queued. */
  apply(cmd: C): Result<void, R | BusReject | "not-ready">;
}

export interface EventDef<E> {
  id: ChannelId;
  schema: Schema<E>;
}

export interface EventHandle<E> {
  readonly events: Listenable<{ event: E; from: PeerId }>;
  /** Also delivers locally to the sender (the bus does it; transport never echoes). */
  broadcast(event: E): void;
  sendTo(peer: PeerId, event: E): void;
}

export interface PrivateDef<P, S> {
  id: ChannelId;
  schema: Schema<P>;
  /** The state channel whose slot carries the revisions. */
  of: { readonly value: Store<S | undefined> };
  /** The revisions the replicated state says exist. A piece is current only if it matches. */
  revisions(state: S): { round: number; rev: Readonly<Record<PlayerId, number>> } | undefined;
}

export interface PrivateHandle<P> {
  /** This player's own piece, if it matches the replicated revisions. */
  readonly mine: Store<P | undefined>;
  /** Host side: any player's piece, as of the current revisions. */
  view(playerId: PlayerId): P | undefined;
}

export interface Bus {
  readonly sync: Store<BusSync>;
  /** Continuous host time, in ms. */
  now(): number;
  state<S, C extends Cmd, R extends string>(def: StateDef<S, C, R>): StateHandle<S, C, R>;
  events<E>(def: EventDef<E>): EventHandle<E>;
  priv<P, S>(def: PrivateDef<P, S>): PrivateHandle<P>;
  /** Register every channel first; registering after start() throws. */
  start(): void;
}

export interface BusDeps {
  transport: Transport;
  localPlayerId: PlayerId;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  config: BusConfig;
}
