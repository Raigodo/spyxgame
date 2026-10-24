// `defineGame`: turns a typed GameSpec into a GameDef whose non-generic `runtime` is a set of pure
// functions over erased values. Only the framework sees the runtime, so games of different types
// sit in one array. Programmer errors in a definition throw here, at module load, never at play time.
// Replaces legacy game-definition.ts + game-runtime.ts (createRuntime); logic ported, not changed.

import { fail, isRecord, ok, type Issue, type PlayerId, type Result } from "@/kernel";
import type {
  CommandWho,
  GameDef,
  GameRuntime,
  GameSpec,
  GameTypes,
  LateOutcome,
  LobbyMode,
  Migrate,
  PresenceChange,
  PrivateView,
  RawEffect,
  Reduction,
  RejoinStrategy,
  RosterArgs,
  Sender,
  SetupOf,
  Slot,
  StartInput,
  StartPlan,
  ModeOf,
  ReduceArgs,
  TimerArgs,
} from "./model";
import { awayOf } from "./slot/presence";
import { setupView } from "./view";

const EMPTY_VIEW: PrivateView<never> = { get: () => undefined };

const own = <V>(table: Record<string, V> | undefined, key: string): V | undefined =>
  table !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** Runs the migration only for an older value. A throwing migration yields undefined (invalid). */
function migrateIfOlder(
  raw: unknown,
  from: number,
  current: number,
  migrate: Migrate | undefined
): unknown {
  if (from >= current || !migrate) return raw;
  try {
    return migrate(raw, from);
  } catch {
    return undefined;
  }
}

/** What a game's reducers return, with the game's types erased. */
type ErasedOutcome = Result<
  { state: unknown; effects?: readonly RawEffect[]; private?: Record<string, unknown> },
  string
>;
type ErasedCommand = {
  who?: CommandWho;
  schema: { check(input: unknown): Result<unknown, Issue> };
  reduce(a: ReduceArgs<GameTypes>, command: unknown): ErasedOutcome;
};
type ErasedTimer = {
  schema?: { check(input: unknown): Result<unknown, Issue> };
  reduce(a: TimerArgs<GameTypes>, payload: unknown): ErasedOutcome;
};
type ErasedChange = {
  state: unknown;
  effects?: readonly RawEffect[];
  private?: Record<string, unknown>;
};

const toReduction = (value: ErasedChange): Reduction => ({
  state: value.state,
  effects: value.effects ?? [],
  ...(value.private && { private: value.private }),
});

export function defineGame<T extends GameTypes>(spec: GameSpec<T>): GameDef<T> {
  const version = spec.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`[${spec.id}] version must be an integer of at least 1.`);
  }
  if (spec.modes.length === 0) throw new Error(`[${spec.id}] modes must not be empty.`);
  const minPresent = spec.presence?.minPresent;
  if (minPresent !== undefined && (!Number.isInteger(minPresent) || minPresent < 1)) {
    throw new Error(`[${spec.id}] presence.minPresent must be an integer of at least 1.`);
  }
  const players = {
    min: spec.players?.min ?? 1,
    max: spec.players?.max ?? Number.POSITIVE_INFINITY,
  };
  if (players.min > players.max) throw new Error(`[${spec.id}] players.min exceeds players.max.`);

  const modes: readonly LobbyMode[] = spec.modes;
  const commands = spec.commands as unknown as Record<string, ErasedCommand>;
  const events = spec.events as unknown as
    Record<string, { schema: { check(input: unknown): Result<unknown, Issue> } }> | undefined;
  const timerDefs = spec.timers as unknown as Record<string, ErasedTimer> | undefined;
  const rejoinRule = spec.presence?.rejoin ?? "restore";

  const common = (slot: Slot, view: PrivateView<unknown>) => ({
    state: slot.state,
    settings: slot.settings,
    setup: setupView(slot.setup),
    away: awayOf(slot),
    seed: slot.seed,
    private: view,
  });
  const roster = (slot: Slot, view: PrivateView<unknown>) => ({
    ...common(slot, view),
    names: slot.setup.names,
  });
  // The erased calls below hand the game exactly the shapes its typed spec declared.
  const asArgs = <A>(args: unknown): A => args as A;

  const runtime: GameRuntime = {
    id: spec.id,
    version,
    modes,
    players,
    presence: {
      ...(spec.presence?.awayAfterMs !== undefined && { awayAfterMs: spec.presence.awayAfterMs }),
      ...(minPresent !== undefined && { minPresent }),
      belowMin: spec.presence?.belowMin ?? "continue",
    },

    parseSettings: (raw, from) =>
      spec.settings.check(migrateIfOlder(raw, from, version, spec.migrate?.settings)),
    parseState: (raw, from) =>
      spec.state.check(migrateIfOlder(raw, from, version, spec.migrate?.state)),

    parseTimerPayload(timer, raw) {
      const def = own(timerDefs, timer);
      if (!def) return undefined;
      if (!def.schema) return { value: undefined };
      const result = def.schema.check(raw);
      return result.ok ? { value: result.value } : undefined;
    },

    parseEvent(raw) {
      if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
      const def = own(events, raw.type);
      const result = def?.schema.check(raw);
      return result?.ok ? { value: result.value } : undefined;
    },

    parsePrivate(raw) {
      const result = spec.private?.schema.check(raw);
      return result?.ok ? { value: result.value } : undefined;
    },

    commandWho(type) {
      const def = own(commands, type);
      return def ? (def.who ?? "participant") : undefined;
    },

    start(
      input: StartInput
    ): Result<
      StartPlan,
      "invalid-settings" | "unsupported-mode" | "too-few-players" | "too-many-players"
    > {
      const { setup, seed } = input;
      if (!modes.some((mode) => mode === setup.mode)) return fail("unsupported-mode");
      if (setup.participants.length < players.min) return fail("too-few-players");
      if (setup.participants.length > players.max) return fail("too-many-players");
      const settings = spec.settings.check(input.settings);
      if (!settings.ok) return fail("invalid-settings");

      const view = setupView(setup);
      const state = spec.init({
        settings: settings.value,
        setup: asArgs<SetupOf<ModeOf<T>>>(view),
        seed,
      });
      const plan: StartPlan = { settings: settings.value, state, private: {} };
      const initial = spec.private?.initial;
      if (initial) {
        const provisional: Slot = {
          gameId: spec.id,
          version,
          seed,
          settings: settings.value,
          state,
          setup,
          x: {},
        };
        for (const playerId of setup.participants) {
          const piece = initial(
            asArgs<RosterArgs<T> & { playerId: PlayerId }>({
              ...roster(provisional, EMPTY_VIEW),
              playerId,
            })
          );
          if (piece !== undefined) plan.private[playerId] = piece;
        }
      }
      return ok(plan);
    },

    play(slot: Slot, command: unknown, sender: Sender, view: PrivateView<unknown>) {
      if (!isRecord(command) || typeof command.type !== "string") return fail("unknown-command");
      const def = own(commands, command.type);
      if (!def) return fail("unknown-command");
      const parsed = def.schema.check(command);
      if (!parsed.ok) return fail("invalid");
      const out = def.reduce({ ...common(slot, view), sender }, parsed.value);
      return out.ok ? ok(toReduction(out.value)) : out;
    },

    fire(slot: Slot, timer: string, payload: unknown, view: PrivateView<unknown>) {
      const def = own(timerDefs, timer);
      if (!def) return undefined;
      const out = def.reduce(common(slot, view), payload);
      return out.ok ? ok(toReduction(out.value)) : out;
    },

    late(slot: Slot, playerId: PlayerId): LateOutcome | undefined {
      const decision = spec.late?.(
        asArgs<RosterArgs<T> & { playerId: PlayerId }>({ ...roster(slot, EMPTY_VIEW), playerId })
      );
      if (!decision) return undefined;
      return {
        ...(decision.team !== undefined && { team: decision.team }),
        ...(decision.replaces !== undefined && { replaces: decision.replaces }),
        ...(decision.state !== undefined && { state: decision.state }),
        ...(decision.private !== undefined && { private: decision.private }),
      };
    },

    rejoin(slot: Slot, playerId: PlayerId): RejoinStrategy {
      return typeof rejoinRule === "function"
        ? rejoinRule(
            asArgs<RosterArgs<T> & { playerId: PlayerId }>({
              ...roster(slot, EMPTY_VIEW),
              playerId,
            })
          )
        : rejoinRule;
    },

    changed(slot: Slot, changes: readonly PresenceChange[], view: PrivateView<unknown>) {
      const result = spec.presence?.onChange?.(
        asArgs<RosterArgs<T> & { changes: readonly PresenceChange[] }>({
          ...roster(slot, view),
          changes,
        })
      );
      return result ? toReduction(result as ErasedChange) : undefined;
    },

    initialPrivate(slot: Slot, playerId: PlayerId) {
      return spec.private?.initial?.(
        asArgs<RosterArgs<T> & { playerId: PlayerId }>({ ...roster(slot, EMPTY_VIEW), playerId })
      );
    },

    recoverPrivate(slot: Slot, playerId: PlayerId) {
      return spec.private?.recover?.(
        asArgs<RosterArgs<T> & { playerId: PlayerId }>({ ...roster(slot, EMPTY_VIEW), playerId })
      );
    },
  };

  return { id: spec.id, modes, runtime };
}
