// The host's game loop: one watcher, no passes. While this peer is host and the bus is `ready`,
// each input change applies the idempotent host commands `observe` and `fire` and arms one
// wake-up at the next away boundary or timer deadline. The truth is always in the slot; the timer
// is only a nudge, so a new host rebuilds everything from replicated state.
//
// A commit changes `value`, which runs the watcher again; each command returns the same state when
// it has nothing to do, so the loop ends by itself. `maxSettlePasses` is only a safety net.

import type { BusSync, StateHandle } from "@/bus";
import type { Cancel, Clock, Listenable, Logger, PlayerId, Scope, Store } from "@/kernel";
import type { GameConfig } from "./config";
import type { GameCommand, GameRuntime, GameState, InputPlayer } from "./model";
import { nextWakeAt } from "./rules";
import { dueTimers } from "./slot/timers";

export type HostFlowDeps = {
  role: Store<"guest" | "host">;
  sync: Store<BusSync>;
  value: Store<GameState | undefined>;
  players: Store<readonly InputPlayer[]>;
  /** Players removed on purpose (kick, ban). */
  removed: Listenable<PlayerId>;
  state: Pick<StateHandle<GameState, GameCommand, string>, "apply">;
  /** Continuous host time (`bus.now`). */
  now(): number;
  runtimes: ReadonlyMap<string, GameRuntime>;
  clock: Clock;
  log: Logger;
  config: GameConfig;
};

export function startHostFlow(deps: HostFlowDeps, scope: Scope): void {
  const { role, sync, value, players, state, runtimes, clock, log, config } = deps;

  /** Removed on purpose, kept until an `observe` has applied them (a "not-ready" must not lose them). */
  const pendingRemoved = new Set<PlayerId>();
  let cancelWake: Cancel | undefined;
  let running = false;
  let again = false;
  let passes = 0;

  const disarm = (): void => {
    cancelWake?.();
    cancelWake = undefined;
  };

  function step(): void {
    disarm();
    if (role.get() !== "host" || sync.get() !== "ready") return;
    const first = value.get()?.slot;
    if (!first) {
      pendingRemoved.clear();
      return;
    }
    if (!runtimes.has(first.gameId)) return; // a game this build cannot run: nothing to do

    const removed = Array.from(pendingRemoved);
    const observed = state.apply({
      type: "observe",
      players: players.get().map((p) => ({ id: p.id, name: p.name, here: p.here })),
      removed,
    });
    if (observed.ok) {
      for (const id of removed) pendingRemoved.delete(id);
    } else if (observed.reason === "not-ready") {
      return; // runs again when the bus becomes ready
    } else {
      log.warn("observe rejected", { reason: observed.reason });
    }

    const afterObserve = value.get()?.slot;
    if (afterObserve) {
      for (const id of dueTimers(afterObserve, deps.now())) {
        if (!value.get()?.slot) break; // the game ended
        const fired = state.apply({ type: "fire", id });
        if (!fired.ok && fired.reason === "not-ready") return;
      }
    }

    const slot = value.get()?.slot ?? null;
    const at = nextWakeAt(slot, slot ? runtimes.get(slot.gameId) : undefined, config);
    if (at !== undefined) {
      const delay = Math.max(config.minWakeMs, at - deps.now());
      cancelWake = clock.after(delay, () => run(true));
    }
  }

  function run(external: boolean): void {
    if (running) {
      again = true; // caused by our own commit
      return;
    }
    if (external) passes = 0;
    running = true;
    try {
      for (;;) {
        again = false;
        step();
        if (!again) break;
        passes += 1;
        if (passes > config.maxSettlePasses) {
          log.warn("host loop did not settle", { passes });
          break;
        }
      }
    } finally {
      running = false;
    }
  }

  const rerun = (): void => run(true);
  scope.add(role.subscribe(rerun));
  scope.add(sync.subscribe(rerun));
  scope.add(value.subscribe(rerun));
  scope.add(players.subscribe(rerun));
  scope.on(deps.removed, (id) => {
    pendingRemoved.add(id);
    run(true);
  });
  scope.add(disarm);
  run(true);
}
