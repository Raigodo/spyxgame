// Runs only on the host, only when the bus is ready. Idempotent: the client
// calls reconcile() whenever the room state, bus status, host role or roster
// changes, and it does nothing unless something is out of line.
//
// It is also the failover repair: a newly promoted host calls this after
// recovery and creates, resets or completes the slot from the replicated room
// state alone. Away, paused, dropped, timers and lost private pieces are derived the same way:
// the replicated slot is the truth, the local Clock timers (absence, game timers) only wake the
// host up. Private pieces are committed before the slot that references them is published.

import type { StateChannel } from "@/shared/application/messaging";
import type { Clock, GameConfig, Logger } from "@/shared/kernel";
import { AbsenceTimers } from "./absence-timers";
import type { ActiveGame } from "./game-context";
import { EMPTY_VIEW, type PrivateStore, type PrivateView, type PrivateWrite } from "./game-private";
import { findAbsent } from "./game-presence";
import {
  MAX_NAME_LENGTH,
  type GameRuntime,
  type Slot,
  type SlotValue,
  type Step,
} from "./game-runtime";
import { syncTimerPause } from "./game-timers";
import { TimerScheduler } from "./timer-scheduler";

/** The part of the room state the host runtime reads. RoomState satisfies it. */
export interface HostRoomView {
  phase: "lobby" | "in-game";
  round: number;
  game?: ActiveGame;
}

export interface GameHostEntry {
  runtime: GameRuntime;
  channel: StateChannel<SlotValue>;
  /** Present when the game declares private per-player state. */
  priv?: PrivateStore;
}

export interface RosterEntry {
  playerId: string;
  nickname: string;
  /** False for a "reconnecting" ghost row: the player is gone for now. */
  present: boolean;
}

export interface GameHostDeps {
  /** True only when this client is host and the bus finished recovery. */
  isHostReady(): boolean;
  getRoomState(): HostRoomView;
  /** Everyone the host currently sees, ghost rows included. */
  getRoster(): readonly RosterEntry[];
  /** Ends the running game (belowMin "end", or an `end` effect). */
  endGame(): void;
  clock: Clock;
  config: GameConfig;
  logger: Logger;
}

// A publish re-enters through change handlers and is skipped by `busy`, so a pass that published
// is followed by another one (bounded) to settle late joiners, absence timers and a game end.
const MAX_PASSES = 3;

const viewOf = (priv: PrivateStore | undefined, slot: Slot): PrivateView<unknown> =>
  priv ? priv.view(slot) : EMPTY_VIEW;

export class GameHostRuntime {
  private busy = false;
  private readonly absence = new Map<string, AbsenceTimers>();
  private readonly schedulers = new Map<string, TimerScheduler>();
  /** Players removed on purpose (kick, ban), until the next pass has demoted them. */
  private readonly removed = new Set<string>();
  /** gameId -> round for which endGame() was already requested. */
  private readonly ending = new Map<string, number>();

  constructor(
    private readonly games: ReadonlyMap<string, GameHostEntry>,
    private readonly deps: GameHostDeps
  ) {}

  reconcile(): void {
    if (this.busy || !this.deps.isHostReady()) return;
    this.busy = true;
    try {
      let settled = false;
      for (let i = 0; i < MAX_PASSES && !settled; i++) settled = !this.pass();
      if (!settled) this.deps.logger.warn("reconcile did not settle");
    } catch (error) {
      this.deps.logger.warn("reconcile failed", error);
    } finally {
      this.busy = false;
    }
  }

  /** A player was removed on purpose: they leave the participants at once, not after the away delay. */
  dropPlayer(playerId: string): void {
    if (!this.deps.isHostReady()) return; // only the host acts; a failover falls back to "away"
    this.removed.add(playerId);
    this.reconcile();
  }

  /** Drops every local timer and note: demotion, teardown. The next host re-derives from the slot. */
  reset(): void {
    for (const timers of this.absence.values()) timers.clear();
    for (const scheduler of this.schedulers.values()) scheduler.clear();
    this.removed.clear();
    this.ending.clear();
  }

  /** One sweep over all games. Returns true if it published or ended anything. */
  private pass(): boolean {
    const room = this.deps.getRoomState();
    const roster = this.deps.getRoster();
    let changed = false;

    for (const { runtime, channel, priv } of this.games.values()) {
      const slot = channel.get();
      const absence = this.absenceFor(runtime.id);
      const scheduler = this.schedulerFor(runtime.id);
      const active =
        room.phase === "in-game" && room.game?.id === runtime.id ? room.game : undefined;

      if (!active) {
        absence.clear();
        scheduler.clear();
        priv?.clear();
        this.ending.delete(runtime.id);
        if (slot !== null) {
          channel.publish(null); // game ended (or never was this one)
          changed = true;
        }
        continue;
      }
      if (!slot || slot.round !== room.round) {
        absence.clear();
        scheduler.clear();
        priv?.startRound(room.round);
        const created = runtime.createSlot(
          room.round,
          active.config,
          active.context,
          namesOf(roster)
        );
        priv?.commit(created.writes);
        channel.publish(created.slot);
        changed = true;
        continue;
      }

      const admitted = admitAndName(runtime, slot, roster);
      priv?.commit(admitted.writes);
      const present = new Set(roster.filter((p) => p.present).map((p) => p.playerId));
      absence.sync(
        findAbsent(admitted.slot, present),
        runtime.awayAfterMs ?? this.deps.config.awayAfterMs
      );

      const now = this.deps.clock.now();
      const update = runtime.updatePresence(
        admitted.slot,
        present,
        absence.getExpired(),
        this.removed,
        now,
        viewOf(priv, admitted.slot)
      );
      priv?.commit(update.writes);
      // After a failover or a host refresh the pieces are gone: the game may rebuild them.
      const recovered = runtime.recoverPrivate(update.slot, viewOf(priv, update.slot));
      priv?.commit(recovered.writes);

      const next = syncTimerPause(recovered.slot, now); // timers freeze while paused
      if (next !== slot) {
        channel.publish(next);
        changed = true;
      }
      scheduler.sync(next.timers);
      priv?.flush(); // roster changes: a refreshed or returning owner gets its piece

      if ((update.end || next.endRequested) && this.ending.get(runtime.id) !== room.round) {
        this.ending.set(runtime.id, room.round);
        this.deps.endGame();
        changed = true; // the room state changed: another pass clears the slot
      }
    }

    this.removed.clear();
    return changed;
  }

  /** A game timer reached its deadline: run its handler and publish, with the timer removed. */
  private fireTimer(gameId: string, timerId: string): void {
    const entry = this.games.get(gameId);
    if (!entry || !this.deps.isHostReady()) return; // the next pass re-arms it
    try {
      const slot = entry.channel.get();
      if (slot) {
        const step = entry.runtime.fireTimer(
          slot,
          timerId,
          this.deps.clock.now(),
          viewOf(entry.priv, slot)
        );
        if (step.slot !== slot) {
          entry.priv?.commit(step.writes);
          entry.channel.publish(step.slot);
        }
      }
    } catch (error) {
      this.deps.logger.warn("timer failed", error);
    }
    this.reconcile();
  }

  private absenceFor(gameId: string): AbsenceTimers {
    let timers = this.absence.get(gameId);
    if (!timers) {
      timers = new AbsenceTimers({ clock: this.deps.clock, onExpired: () => this.reconcile() });
      this.absence.set(gameId, timers);
    }
    return timers;
  }

  private schedulerFor(gameId: string): TimerScheduler {
    let scheduler = this.schedulers.get(gameId);
    if (!scheduler) {
      scheduler = new TimerScheduler({
        clock: this.deps.clock,
        onDue: (timerId) => this.fireTimer(gameId, timerId),
      });
      this.schedulers.set(gameId, scheduler);
    }
    return scheduler;
  }
}

function namesOf(roster: readonly RosterEntry[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const { playerId, nickname } of roster) names[playerId] = nickname.slice(0, MAX_NAME_LENGTH);
  return names;
}

/** Every known player's current nickname is recorded, then late joiners get decided on. */
function admitAndName(runtime: GameRuntime, slot: Slot, roster: readonly RosterEntry[]): Step {
  let next = slot;
  const writes: PrivateWrite[] = [];
  for (const { playerId, nickname } of roster) {
    const name = nickname.slice(0, MAX_NAME_LENGTH);
    if (next.names[playerId] !== name) {
      next = { ...next, names: { ...next.names, [playerId]: name } };
    }
    if (!next.participants.includes(playerId) && !next.spectators.includes(playerId)) {
      const step = runtime.lateJoin(next, playerId); // default: spectator, the game may admit
      next = step.slot;
      writes.push(...step.writes);
    }
  }
  return { slot: next, writes };
}
