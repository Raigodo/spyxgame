// The `game` channel: its dispatching schema and the six commands. Every change to a running game
// is a command with a pure reducer; the host's own changes (observe, fire, end) are idempotent and
// return the same state reference when there is nothing to do. Reducers read only (state, payload,
// ctx) plus the host's private view, which is host-local data that `recover` can rebuild.

import type { PrivateDef, PrivateWrite, StateDef } from "@/bus";
import { fail, isRecord, ok, s, type Issue, type Result, type Store } from "@/kernel";
import type { GameConfig } from "./config";
import type {
  GameCommand,
  GameRuntime,
  GameState,
  ParseEnv,
  PrivateView,
  RegisteredGame,
  Slot,
  SlotEnv,
  SlotSetup,
} from "./model";
import {
  COMMAND,
  GAME_CHANNEL,
  GAME_PRIVATE_CHANNEL,
  LOBBY_MODES,
  MAX_INT32,
  MAX_UINT32,
} from "./names";
import { authorize, checkStart, finish, lateJoin, newcomers, recordNames } from "./rules";
import { applyReduction, createSlot, observeAll, parseX } from "./slot";
import { resume } from "./slot/presence";
import { revisions } from "./slot/private";
import { consumeTimer, isDue, syncTimers, timersOf } from "./slot/timers";

export const INITIAL_STATE: GameState = { round: 1, slot: null };

export type GameChannelDeps = {
  games: readonly RegisteredGame[];
  config: GameConfig;
  /** The host's private pieces (bus.priv(...).view), bound after the channels exist. */
  view: () => PrivateView<unknown>;
};

const issue = (path: string, expected: string): Result<never, Issue> => fail({ path, expected });

// ─── Schemas ────────────────────────────────────────────────────────────────

function setupSchema(config: GameConfig) {
  const max = config.maxSlotPlayers;
  const label = s.string({ min: 1, max: config.maxIdChars });
  return s.object({
    mode: s.oneOf(LOBBY_MODES),
    teamIds: s.optional(s.list(label, { max, onInvalid: "reject" })),
    teams: s.record(label, { maxKeys: max, onInvalid: "drop" }),
    participants: s.list(s.id("player"), { max, onInvalid: "reject" }),
    spectators: s.list(s.id("player"), { max, onInvalid: "reject" }),
    names: s.record(s.string({ max: config.maxNameChars }), { maxKeys: max, onInvalid: "drop" }),
  });
}

/**
 * The slot schema dispatches by game id. A known game: its settings and state schemas run, older
 * versions migrate first, a newer version rejects. An unknown game id is kept opaque (settings
 * and state unvalidated) so the channel keeps syncing `round` and `last`.
 */
function slotSchema(runtimes: ReadonlyMap<string, GameRuntime>, config: GameConfig) {
  const core = s.object({
    gameId: s.string({ min: 1, max: config.maxIdChars }),
    version: s.int({ min: 1, max: MAX_INT32 }),
    seed: s.int({ min: 0, max: MAX_UINT32 }),
    setup: setupSchema(config),
  });
  return s.custom<Slot>((raw) => {
    const parsed = core.check(raw);
    if (!parsed.ok) return parsed;
    const { gameId, version, seed, setup } = parsed.value;
    const rec = raw as Record<string, unknown>; // `core` proved it is an object
    const runtime = runtimes.get(gameId);

    if (!runtime) {
      if (rec.x !== undefined && !isRecord(rec.x)) return issue("x", "record");
      return ok({
        gameId,
        version,
        seed,
        setup,
        settings: rec.settings,
        state: rec.state,
        x: rec.x ?? {},
      });
    }
    if (version > runtime.version) return issue("version", `at most ${runtime.version}`);
    const settings = runtime.parseSettings(rec.settings, version);
    if (!settings.ok) return fail({ path: "settings", expected: settings.reason.expected });
    const state = runtime.parseState(rec.state, version);
    if (!state.ok) return fail({ path: "state", expected: state.reason.expected });
    const env: ParseEnv = { config, runtime };
    const x = parseX(rec.x, setup, env);
    if (!x) return issue("x", "valid slot features");
    return ok({
      gameId,
      version: runtime.version,
      seed,
      setup,
      settings: settings.value,
      state: state.value,
      x,
    });
  });
}

function stateSchema(runtimes: ReadonlyMap<string, GameRuntime>, config: GameConfig) {
  return s.object({
    round: s.int({ min: 1, max: MAX_INT32 }),
    last: s.optional(
      s.object({
        gameId: s.string({ min: 1, max: config.maxIdChars }),
        settings: s.json({ maxChars: config.maxSettingsChars }),
      })
    ),
    slot: s.nullable(slotSchema(runtimes, config)),
  });
}

// ─── The channel ────────────────────────────────────────────────────────────

export function gameStateDef(deps: GameChannelDeps): StateDef<GameState, GameCommand, string> {
  const { config } = deps;
  const runtimes = new Map(deps.games.map((game) => [game.id, game.runtime]));
  const max = config.maxSlotPlayers;
  const players = s.list(
    s.object({
      id: s.id("player"),
      // Any length: the roster owns the nickname cap, `recordNames` cuts it for the slot.
      name: s.custom<string>((v) => (typeof v === "string" ? ok(v) : issue("name", "string"))),
      here: s.boolean(),
    }),
    { max, onInvalid: "reject" }
  );
  const ids = s.list(s.id("player"), { max, onInvalid: "reject" });
  const command = s.custom<unknown>((input) =>
    isRecord(input) && typeof input.type === "string"
      ? ok(input)
      : issue("command", "object with a type")
  );

  const envFor = (runtime: GameRuntime, ctx: { now: number }, round: number): SlotEnv => ({
    config,
    runtime,
    now: ctx.now,
    round,
    private: deps.view(),
  });

  /** The state and writes of a committed pipeline result; an `end` becomes `finish`, with no writes. */
  const settle = (
    state: GameState,
    done: { slot: Slot; writes: readonly PrivateWrite[]; end: boolean }
  ) =>
    done.end
      ? ok({ state: finish({ ...state, slot: done.slot }) })
      : ok({ state: { ...state, slot: done.slot }, privateWrites: done.writes });

  const noop = (state: GameState) => ok({ state });

  return {
    id: GAME_CHANNEL,
    schema: stateSchema(runtimes, config),
    init: INITIAL_STATE,
    commands: {
      [COMMAND.start]: {
        who: "host",
        schema: s.object({
          type: s.literal(COMMAND.start),
          gameId: s.string({ min: 1, max: config.maxIdChars }),
          settings: s.json({ maxChars: config.maxSettingsChars }),
          setup: setupSchema(config),
          seed: s.int({ min: 0, max: MAX_UINT32 }),
        }),
        reduce(state, p, ctx) {
          const runtime = runtimes.get(p.gameId);
          const rejected = checkStart(state, runtime, p.settings, p.setup, config);
          if (rejected || !runtime) return fail(rejected ?? "unknown-game");
          const plan = runtime.start({ settings: p.settings, setup: p.setup, seed: p.seed });
          if (!plan.ok) return plan;
          const created = createSlot(
            { runtime, plan: plan.value, setup: p.setup as SlotSetup, seed: p.seed },
            envFor(runtime, ctx, state.round)
          );
          if (!created.ok) return fail(created.reason);
          return ok({
            state: { ...state, slot: created.value.slot },
            privateWrites: created.value.writes,
          });
        },
      },

      [COMMAND.play]: {
        who: "anyone",
        schema: s.object({
          type: s.literal(COMMAND.play),
          gameId: s.string({ min: 1, max: config.maxIdChars }),
          command,
        }),
        reduce(state, p, ctx) {
          const { slot } = state;
          const runtime = slot ? runtimes.get(slot.gameId) : undefined;
          const type = (p.command as { type: string }).type; // proved by `command`
          const rejected = authorize(slot, runtime, p.gameId, type, {
            fromHost: ctx.fromHost,
            ...(ctx.playerId !== undefined && { playerId: ctx.playerId }),
          });
          if (rejected) return fail(rejected);
          if (!slot || !runtime) return fail("no-active-game");
          if (ctx.playerId === undefined) return fail("unknown-sender");
          const env = envFor(runtime, ctx, state.round);
          const out = runtime.play(
            slot,
            p.command,
            { playerId: ctx.playerId, peerId: ctx.from },
            env.private
          );
          if (!out.ok) return out;
          const done = applyReduction(slot, out.value, env);
          return done.ok ? settle(state, done.value) : fail(done.reason);
        },
      },

      [COMMAND.observe]: {
        who: "host",
        schema: s.object({ type: s.literal(COMMAND.observe), players, removed: ids }),
        reduce(state, p, ctx) {
          const { slot } = state;
          const runtime = slot ? runtimes.get(slot.gameId) : undefined;
          if (!slot || !runtime) return noop(state); // nothing to watch, or a game this build cannot run
          const env = envFor(runtime, ctx, state.round);
          const observation = { players: p.players, removed: p.removed };

          let next = recordNames(slot, observation, config);
          const writes: PrivateWrite[] = [];
          for (const playerId of newcomers(next, observation)) {
            const placed = lateJoin(next, playerId, runtime, env);
            next = placed.slot;
            writes.push(...placed.writes);
          }
          const done = observeAll(next, observation, env);
          writes.push(...done.writes);
          if (done.slot === slot && writes.length === 0 && !done.end) return noop(state);
          return settle(state, { slot: done.slot, writes, end: done.end });
        },
      },

      [COMMAND.fire]: {
        who: "host",
        schema: s.object({
          type: s.literal(COMMAND.fire),
          id: s.string({ min: 1, max: config.maxTimerIdChars }),
        }),
        reduce(state, p, ctx) {
          const { slot } = state;
          const runtime = slot ? runtimes.get(slot.gameId) : undefined;
          if (!slot || !runtime || !isDue(slot, p.id, ctx.now)) return noop(state);
          const timer = timersOf(slot)[p.id];
          if (!timer) return noop(state);
          // The timer is consumed in this commit whatever its handler does.
          const rest = consumeTimer(slot, p.id);
          const consumed = ok({ state: { ...state, slot: rest } });
          const env = envFor(runtime, ctx, state.round);
          const out = runtime.fire(rest, timer.timer, timer.payload, env.private);
          if (!out?.ok) return consumed;
          const done = applyReduction(rest, out.value, env);
          return done.ok ? settle(state, done.value) : consumed;
        },
      },

      [COMMAND.continue]: {
        who: "host",
        schema: s.object({ type: s.literal(COMMAND.continue) }),
        reduce(state, _p, ctx) {
          if (!state.slot) return fail("no-active-game");
          const resumed = resume(state.slot);
          if (!resumed) return fail("not-paused");
          return ok({ state: { ...state, slot: syncTimers(resumed, ctx.now) } });
        },
      },

      [COMMAND.end]: {
        who: "host",
        schema: s.object({ type: s.literal(COMMAND.end) }),
        reduce(state) {
          return state.slot ? ok({ state: finish(state) }) : fail("not-playing");
        },
      },
    },
  };
}

/** The private pieces of the `game` channel: revisions come from the slot's `private` feature. */
export function gamePrivateDef(
  deps: Pick<GameChannelDeps, "config">,
  state: { readonly value: Store<GameState | undefined> }
): PrivateDef<unknown, GameState> {
  return {
    id: GAME_PRIVATE_CHANNEL,
    // The game's own schema runs where the piece is read (GameHandle), because a piece can arrive
    // before the slot that names its game.
    schema: s.json({ maxChars: deps.config.maxPieceChars }),
    of: state,
    revisions,
  };
}
