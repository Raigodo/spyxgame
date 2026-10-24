// The guest side of the roster, active only while this peer is a guest:
//  1. repeat `join` until the replicated roster holds this peer's row (a lost command heals itself),
//  2. answer the host's duplicate-tab pings.
// A ban or a full room ends the attempts and is reported as `refused`.

import {
  Emitter,
  type Cancel,
  type Clock,
  type Listenable,
  type Logger,
  type PlayerId,
  type Unsubscribe,
} from "@/kernel";
import type { Bus } from "@/bus";
import type { Transport } from "@/transport";
import type { RosterConfig } from "./config";
import type { RefusalReason } from "./model";
import { EVENT } from "./names";
import type { RosterEventsHandle, RosterStateHandle } from "./state";

export interface GuestFlowDeps {
  transport: Pick<Transport, "self" | "role" | "host">;
  bus: Pick<Bus, "sync">;
  state: RosterStateHandle;
  events: RosterEventsHandle;
  localPlayerId: PlayerId;
  /** The nickname for the join. */
  getName(): string;
  clock: Clock;
  log: Logger;
  config: Pick<RosterConfig, "joinRetryMs">;
}

export class GuestFlow {
  private readonly deps: GuestFlowDeps;
  private readonly refusals = new Emitter<RefusalReason>();
  private unsubscribes: Unsubscribe[] = [];
  private retry: Cancel | undefined;
  private inFlight = false;
  /** True between an attempt and its retry timer: no new attempt before it fires. */
  private waiting = false;
  private refused = false;

  constructor(deps: GuestFlowDeps) {
    this.deps = deps;
  }

  /** Fires once when the host refuses this peer (banned or room full). */
  get refusal(): Listenable<RefusalReason> {
    return this.refusals;
  }

  start(): Unsubscribe {
    const { transport, bus, state, events } = this.deps;
    const again = (): void => this.reconcile();
    this.unsubscribes = [
      transport.role.subscribe(again),
      bus.sync.subscribe(again),
      state.value.subscribe(again),
      events.events.on(({ event, from }) => {
        // Only the host may ping; anyone else's ping is ignored.
        if (event.kind === EVENT.ping && from === transport.host.get()) {
          events.sendTo(from, { kind: EVENT.pong, nonce: event.nonce });
        }
      }),
    ];
    this.reconcile();
    return () => this.stop();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.cancelRetry();
  }

  private admitted(): boolean {
    const { state, localPlayerId, transport } = this.deps;
    return state.value.get()?.entries[localPlayerId]?.peerId === transport.self;
  }

  private reconcile(): void {
    if (this.refused || this.deps.transport.role.get() !== "guest") {
      this.cancelRetry();
      return;
    }
    if (this.admitted()) {
      this.cancelRetry();
      return;
    }
    if (this.inFlight || this.waiting) return;
    void this.attempt();
  }

  private async attempt(): Promise<void> {
    const { state, clock, log, config } = this.deps;
    this.inFlight = true;
    const result = await state.send({ type: "join", name: this.deps.getName() });
    this.inFlight = false;

    const reason = result.ok ? undefined : result.reason;
    if (reason === "banned" || reason === "full") {
      this.refused = true;
      this.cancelRetry();
      this.refusals.emit(reason);
      return;
    }
    if (reason !== undefined && reason !== "taken") {
      log.warn("Join was not accepted, retrying", { reason });
    }
    // Admitted shows up through the replicated state; if it does not, try again.
    this.waiting = true;
    this.retry = clock.after(config.joinRetryMs, () => {
      this.waiting = false;
      this.retry = undefined;
      this.reconcile();
    });
  }

  private cancelRetry(): void {
    this.retry?.();
    this.retry = undefined;
    this.waiting = false;
  }
}
