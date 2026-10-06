import type { BusConfig } from "@/shared/kernel";

export type PeerId = string;

export type CommandResult =
  { ok: true } | { ok: false; kind: "rejected" | "expired" | "left"; reason: string };

export type BusStatus = "syncing" | "ready";

export type BusOptions = BusConfig;

/**
 * The only thing the bus needs from the layers below. Keeps the bus free of
 * PlayerSession / WebRTC details and trivially testable with a fake.
 *
 * Contract: send/broadcast are best-effort. broadcast() from the host also
 * delivers locally (the bus ignores its own echoes). Message `from` is the
 * host-verified sender.
 */
export interface BusTransport {
  getLocalPeerId(): PeerId | undefined;
  getHostPeerId(): PeerId | undefined;
  isHost(): boolean;
  send(to: PeerId, payload: unknown): void;
  broadcast(payload: unknown): void;
  onMessage(handler: (payload: unknown, from: PeerId) => void): () => void;
  onHostChanged(handler: () => void): () => void;
  /** Fires when a data-channel link to `peerId` becomes active. */
  onLinkActive(handler: (peerId: PeerId) => void): () => void;
  isLinkActive(peerId: PeerId): boolean;
  /** Host side: peers (any link status) the host should hear from after promotion. */
  getExpectedPeerIds(): PeerId[];
}

export interface StateChannelOptions<S> {
  id: string;
  initial: S;
  /** Network input is untrusted: return a sanitized value, or undefined to reject. */
  validate(value: unknown): S | undefined;
  /** Host side: maps a verified sender peerId to its durable playerId, for commands. */
  resolveSender?(peerId: PeerId): string | undefined;
}

export interface CommandSpec<S, P> {
  /** Shorthand: only the host's own client may send this command. */
  hostOnly?: boolean;
  validate(payload: unknown): P | undefined;
  authorize?(ctx: {
    from: PeerId;
    state: S;
    isHostSender: boolean;
    playerId?: string;
  }): string | undefined;
  reduce(
    state: S,
    payload: P,
    ctx: { from: PeerId; playerId?: string }
  ): { ok: true; state: S } | { ok: false; reason: string };
}

export interface EventChannelOptions<E> {
  id: string;
  validate(event: unknown): E | undefined;
}
