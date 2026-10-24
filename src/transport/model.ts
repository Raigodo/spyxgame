import type { Listenable, PeerId, PlayerId, Result, Store } from "@/kernel";

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What travels between peers. Transport stringifies, chunks and reassembles it. */
export type Wire = JsonValue;

/** Membership says nothing about liveness. `playerId` is known on the host only, after a verified hello. */
export interface Member {
  peerId: PeerId;
  joinedAt: number;
  playerId?: PlayerId;
}

export type LinkState = "connecting" | "active" | "reconnecting";
export type DropReason = "kicked" | "superseded";
export type HandOffReject = "not-host" | "target-unavailable" | "host-changed";
export type JoinError = "unavailable";

export interface Transport {
  /** Fresh per join, ULID, never reused. */
  readonly self: PeerId;
  readonly role: Store<"guest" | "host">;
  /** Role and host change in one batch. */
  readonly host: Store<PeerId | undefined>;
  readonly members: Store<ReadonlyMap<PeerId, Member>>;
  /** Host: one per guest. Guest: only the host. */
  readonly links: Store<ReadonlyMap<PeerId, LinkState>>;
  /** Silently dropped unless the link is active. A guest's send to another guest is relayed by the host. */
  send(to: PeerId, msg: Wire): void;
  /** To everyone else, any role, relayed by the host, never echoed to the sender. */
  broadcast(msg: Wire): void;
  /** `from` is host-verified. */
  readonly messages: Listenable<{ from: PeerId; msg: Wire }>;
  /** Host only: send `bye { reason }`, remove from membership, close the link once the bye has drained. */
  drop(peer: PeerId, reason: DropReason): Promise<void>;
  /** This peer received a `bye`, or lost its host link after being removed from members. */
  readonly dropped: Listenable<DropReason>;
  /** Host only. */
  handOff(to: PeerId): Promise<Result<void, HandOffReject>>;
  /** Idempotent, every remote step best-effort. */
  leave(): Promise<void>;
}
