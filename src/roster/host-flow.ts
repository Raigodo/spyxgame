// Everything the roster does only while this peer is the host and the bus is ready:
//  1. keep the replicated roster in step with membership and link states (`sync`),
//  2. keep the host's own row (`join`),
//  3. wake up when the next ghost expires,
//  4. arbitrate duplicate tabs of one player with ping/pong.
// One idempotent `reconcile`, re-run on every input change. No heartbeats, no polling.

import type { Cancel, Clock, Logger, PeerId, PlayerId, Unsubscribe } from "@/kernel";
import type { Bus } from "@/bus";
import type { Transport } from "@/transport";
import type { RosterConfig } from "./config";
import { challengeKey, planDuplicates, resolveChallenge, type Challenge } from "./duplicates";
import { EVENT } from "./names";
import type { RosterCommand } from "./model";
import { nextGhostExpiry } from "./rules";
import type { RosterEventsHandle, RosterStateHandle } from "./state";

export interface HostFlowDeps {
  transport: Pick<Transport, "self" | "role" | "members" | "links" | "drop">;
  bus: Pick<Bus, "sync" | "now">;
  state: RosterStateHandle;
  events: RosterEventsHandle;
  localPlayerId: PlayerId;
  /** The nickname for the host's own row. */
  getName(): string;
  clock: Clock;
  log: Logger;
  config: Pick<RosterConfig, "maxPlayers" | "departureGraceMs" | "pingTimeoutMs" | "linkWaitMs">;
}

interface Pending {
  challenge: Challenge;
  firstSeen: number;
  nonce?: string;
  cancel?: Cancel;
}

const MAX_PASSES = 5;

export class HostFlow {
  private readonly deps: HostFlowDeps;
  private readonly pending = new Map<string, Pending>();
  /** Challenges already resolved and waiting for the drop to show up in membership. */
  private readonly settled = new Set<string>();
  private readonly expelling = new Set<PeerId>();
  private cancelExpiry: Cancel | undefined;
  private unsubscribes: Unsubscribe[] = [];
  private seq = 0;
  private running = false;
  private dirty = false;

  constructor(deps: HostFlowDeps) {
    this.deps = deps;
  }

  start(): Unsubscribe {
    const { transport, bus, state, events } = this.deps;
    const again = (): void => this.reconcile();
    this.unsubscribes = [
      transport.role.subscribe(again),
      transport.members.subscribe(again),
      transport.links.subscribe(again),
      bus.sync.subscribe(again),
      state.value.subscribe(again),
      events.events.on(({ event, from }) => {
        if (event.kind === EVENT.pong) this.onPong(event.nonce, from);
      }),
    ];
    this.reconcile();
    return () => this.stop();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.reset();
  }

  private reconcile(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        this.dirty = false;
        this.pass();
        if (!this.dirty) break;
      }
    } finally {
      this.running = false;
    }
  }

  private pass(): void {
    const { transport, bus } = this.deps;
    if (transport.role.get() !== "host" || bus.sync.get() !== "ready") {
      this.reset();
      return;
    }
    this.syncLinks();
    this.joinSelf();
    this.scheduleExpiry();
    this.arbitrate();
    this.enforceBans();
  }

  private apply(cmd: RosterCommand): void {
    const result = this.deps.state.apply(cmd);
    if (!result.ok && result.reason !== "not-ready") {
      this.deps.log.warn(`Host ${cmd.type} was rejected`, { reason: result.reason });
    }
  }

  // 1. One key per member peer; a member without a link yet is "connecting".
  private syncLinks(): void {
    const { transport, config } = this.deps;
    const links = transport.links.get();
    const keys: Record<string, "connecting" | "active" | "reconnecting"> = {};
    let count = 0;
    for (const peer of transport.members.get().keys()) {
      if (count++ >= config.maxPlayers * 2) break;
      keys[peer] = links.get(peer) ?? "connecting";
    }
    this.apply({ type: "sync", links: keys });
  }

  // 2. The host's own row. Runs after `sync`, so a dead previous peer of ours is already a ghost.
  private joinSelf(): void {
    const { state, transport, localPlayerId } = this.deps;
    const mine = state.value.get()?.entries[localPlayerId];
    if (mine?.peerId === transport.self) return;
    this.apply({ type: "join", name: this.deps.getName() });
  }

  // 3. A ghost becomes removable at a known host time: wake up exactly then.
  private scheduleExpiry(): void {
    const { state, bus, clock, config } = this.deps;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    const value = state.value.get();
    const at = value ? nextGhostExpiry(value, config.departureGraceMs) : undefined;
    if (at === undefined) return;
    this.cancelExpiry = clock.after(Math.max(0, at - bus.now()), () => this.reconcile());
  }

  // 4. Duplicate tabs.
  private arbitrate(): void {
    const { transport, state } = this.deps;
    const value = state.value.get();
    if (!value) return;

    const wanted = new Map<string, Challenge>();
    for (const c of planDuplicates(transport.members.get(), value, transport.self)) {
      wanted.set(challengeKey(c), c);
    }
    for (const [key, p] of this.pending) {
      if (wanted.has(key)) continue;
      p.cancel?.();
      this.pending.delete(key);
    }
    for (const key of this.settled) if (!wanted.has(key)) this.settled.delete(key);

    for (const [key, challenge] of wanted) {
      if (this.settled.has(key)) continue;
      const existing = this.pending.get(key);
      if (!existing) {
        this.pending.set(key, { challenge, firstSeen: this.deps.bus.now() });
        this.advance(key);
      } else if (existing.nonce === undefined) {
        this.advance(key); // maybe the holder's link became active
      }
    }
  }

  // 5. A banned player's peer that is still a member (a client that ignored its refusal).
  private enforceBans(): void {
    const { transport, state, log } = this.deps;
    const bans = state.value.get()?.bans;
    if (!bans || bans.length === 0) return;
    for (const member of transport.members.get().values()) {
      if (!member.playerId || !bans.includes(member.playerId) || this.expelling.has(member.peerId))
        continue;
      this.expelling.add(member.peerId);
      transport
        .drop(member.peerId, "kicked")
        .catch((error: unknown) => log.warn("Dropping a banned peer failed", { error }))
        .finally(() => this.expelling.delete(member.peerId));
    }
  }

  /** Ping the holder once its link is active (or after linkWaitMs), then wait for the pong. */
  private advance(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    const { transport, bus, clock, events, config } = this.deps;
    p.cancel?.();
    p.cancel = undefined;

    if (p.challenge.holder === transport.self) {
      this.resolve(key, true); // the host itself is alive by definition
      return;
    }

    const active = transport.links.get().get(p.challenge.holder) === "active";
    const waited = bus.now() - p.firstSeen;
    if (!active && waited < config.linkWaitMs) {
      p.cancel = clock.after(config.linkWaitMs - waited, () => this.advance(key));
      return;
    }

    p.nonce = `${transport.self}:${++this.seq}`;
    events.sendTo(p.challenge.holder, { kind: EVENT.ping, nonce: p.nonce });
    p.cancel = clock.after(config.pingTimeoutMs, () => this.resolve(key, false));
  }

  private onPong(nonce: string, from: string): void {
    for (const [key, p] of this.pending) {
      if (p.nonce === nonce && p.challenge.holder === from) {
        this.resolve(key, true);
        return;
      }
    }
  }

  private resolve(key: string, holderAnswered: boolean): void {
    const p = this.pending.get(key);
    if (!p) return;
    p.cancel?.();
    this.pending.delete(key);
    this.settled.add(key);
    for (const peer of resolveChallenge(p.challenge, holderAnswered)) {
      this.deps.transport.drop(peer, "superseded").catch((error: unknown) => {
        this.deps.log.warn("Dropping a duplicate tab failed", { peer, error });
        this.settled.delete(key); // retry on the next reconcile
        this.reconcile();
      });
    }
  }

  private reset(): void {
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    for (const p of this.pending.values()) p.cancel?.();
    this.pending.clear();
    this.settled.clear();
    this.expelling.clear();
  }
}
