// Turns a typed GameSpec into a non-generic GameRuntime. The registry, the
// client and the host reconciler only ever see GameRuntime, so heterogeneous
// games can sit in one map without `any`.

import { sanitizeLobbyConfig, type LobbyConfig, type LobbyMode } from "@/shared/application/lobby";
import type { StateChannel } from "@/shared/application/messaging";
import { isInt, isRecord, type Clock } from "@/shared/kernel";
import type { GameContext } from "./game-context";
import type { CommandDef, EventDef, GameSpec, LobbyContext, TimerDef } from "./game-definition";
import {
  applyEffects,
  MAX_NOTICES,
  WithEffects,
  type EffectContext,
  type Notice,
  type RawEffect,
} from "./game-effects";
import {
  applyPrivate,
  EMPTY_VIEW,
  parseRevisions,
  type PrivateStore,
  type PrivateView,
  type PrivateWrite,
} from "./game-private";
import {
  applyQuorum,
  computePresence,
  type QuorumPolicy,
  type RejoinStrategy,
} from "./game-presence";
import { parseTimers, withoutTimer, type SlotTimers } from "./game-timers";
import { migrateIfOlder, readStateVersion } from "./game-version";

/** Built-in host-only command: resume a game paused for lack of players. */
export const CONTINUE_COMMAND = "presence/continue";
const RESERVED_PREFIX = "presence/";

/** The replicated value of a game channel while a game runs. */
export interface Slot {
  /** Matches RoomState.round. A slot from another round is stale. */
  round: number;
  /** The game's `version` when this slot was written. */
  stateVersion: number;
  config: unknown;
  lobby: LobbyConfig;
  participants: string[];
  /** Late joiners who were decided on (admitted ones are in participants), and dropped players. */
  spectators: string[];
  /** Participants currently missing. Written only by the host runtime. */
  away: string[];
  /** Fewer participants than `minPresent` are here: commands other than host ones are rejected. */
  paused: boolean;
  /** The host chose to continue below the minimum. Resets when enough players are back. */
  forced: boolean;
  /** A reducer asked for the game to end. The host runtime acts on it once per round. */
  endRequested: boolean;
  /** Notices emitted by reducers this round, newest last (capped). */
  notices: Notice[];
  /** Sequence number of the latest notice (0 when none). */
  noticeSeq: number;
  /** Timers started by reducers. The host runtime fires them and freezes them while paused. */
  timers: SlotTimers;
  /** playerId -> revision of that player's private piece. The pieces themselves are never replicated. */
  privateRev: Record<string, number>;
  /** Last revision handed out this round (revisions are never reused). */
  privateSeq: number;
  /** playerId -> nickname, copied from the roster by the host, so a player who left keeps a name. */
  names: Record<string, string>;
  /** playerId -> teamId, only in teams mode. */
  teams: Record<string, string>;
  state: unknown;
}

export type SlotValue = Slot | null;

/** A new slot and the private pieces to commit (before publishing it). */
export interface Step {
  slot: Slot;
  writes: PrivateWrite[];
}

export interface PresenceUpdate extends Step {
  /** The game asked to end (belowMin "end" and too few players). */
  end: boolean;
}

export interface GameRuntime {
  readonly id: string;
  /** The game's own away debounce, if it set one. */
  readonly awayAfterMs: number | undefined;
  /** True when the game declares private per-player state. */
  readonly hasPrivate: boolean;
  /** Network input: a sanitized private piece, or undefined. */
  validatePrivate(raw: unknown): unknown;
  /** Host-side check before a game may start. Returns a reason to reject. */
  checkStart(config: unknown, lobby: LobbyConfig, playerCount: number): string | undefined;
  createSlot(
    round: number,
    config: unknown,
    context: GameContext,
    names: Record<string, string>
  ): Step;
  /** null is a valid value (no game running). undefined means invalid. */
  validateSlot(raw: unknown): SlotValue | undefined;
  /** Returns the validated data, or undefined if invalid. */
  validateEvent(name: string, data: unknown): unknown;
  /** The clock stamps timer deadlines; `priv` holds private pieces. Reducers only ever run on the host. */
  installCommands(
    channel: StateChannel<SlotValue>,
    clock: Clock,
    priv: PrivateStore | undefined
  ): void;
  lateJoin(slot: Slot, playerId: string): Step;
  /**
   * Pure. Marks absent players away, restores or demotes returning ones, demotes removed ones,
   * lets the game react, then applies the quorum rule. Same slot back when nothing changed.
   */
  updatePresence(
    slot: Slot,
    present: ReadonlySet<string>,
    expired: ReadonlySet<string>,
    removed: ReadonlySet<string>,
    now: number,
    view: PrivateView<unknown>
  ): PresenceUpdate;
  /** Pure. Runs the handler of a timer that reached its deadline and removes it. Same slot if it is gone, frozen or paused. */
  fireTimer(slot: Slot, timerId: string, now: number, view: PrivateView<unknown>): Step;
  /** Pure. Asks the game to rebuild private pieces the host does not hold. Same slot when nothing was rebuilt. */
  recoverPrivate(slot: Slot, view: PrivateView<unknown>): Step;
}

export function toLobbyContext<M extends LobbyMode>(slot: Slot): LobbyContext<M> {
  const context =
    slot.lobby.mode === "teams"
      ? {
          mode: "teams" as const,
          teamIds: slot.lobby.teamIds,
          participants: slot.participants,
          teams: slot.teams,
        }
      : { mode: "free-for-all" as const, participants: slot.participants };
  // Safe: startGame is rejected unless the lobby mode is one of spec.modes.
  return context as unknown as LobbyContext<M>;
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

export const MAX_NAME_LENGTH = 64;
const MAX_NAMES = 200;

/** Network input: clips each name, rejects a non-record or an oversized map. */
function parseNames(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.length > MAX_NAMES) return undefined;
  const names: Record<string, string> = {};
  for (const [playerId, name] of entries) {
    if (typeof name === "string") names[playerId] = name.slice(0, MAX_NAME_LENGTH);
  }
  return names;
}

/** Absent in slots from an older host: false. Present but not a boolean: invalid. */
const flag = (v: unknown): boolean | undefined =>
  v === undefined ? false : typeof v === "boolean" ? v : undefined;

export function createRuntime<
  C,
  S,
  Cmds extends object,
  Evs extends object,
  M extends LobbyMode,
  H,
>(spec: GameSpec<C, S, Cmds, Evs, M, H>): GameRuntime {
  const modes: readonly LobbyMode[] = spec.modes;
  const minPlayers = spec.minPlayers ?? 1;
  const maxPlayers = spec.maxPlayers ?? Number.POSITIVE_INFINITY;
  const rejoinRule = spec.presence?.rejoin ?? "restore";
  const commands = spec.commands as unknown as Record<string, CommandDef<C, S, M, unknown, Evs, H>>;
  const events = spec.events as unknown as Record<string, EventDef<unknown>> | undefined;
  const timerDefs = spec.timers as unknown as Record<string, TimerDef<C, S, M, Evs, H>> | undefined;
  const validateEvent = (name: string, data: unknown): unknown => events?.[name]?.validate(data);
  const privateSpec = spec.privateState;
  const validatePrivate = (raw: unknown): unknown => privateSpec?.validate(raw);
  const privateValidator = privateSpec ? validatePrivate : undefined;
  const asView = (view: PrivateView<unknown>): PrivateView<H> => view as PrivateView<H>;

  for (const name of Object.keys(commands)) {
    if (name.startsWith(RESERVED_PREFIX)) {
      throw new Error(
        `[${spec.id}] Command "${name}" uses the reserved "${RESERVED_PREFIX}" prefix.`
      );
    }
  }
  const minPresent = spec.presence?.minPresent;
  if (minPresent !== undefined && (!Number.isInteger(minPresent) || minPresent < 1)) {
    throw new Error(`[${spec.id}] presence.minPresent must be an integer of at least 1.`);
  }
  const quorum: QuorumPolicy | undefined =
    minPresent === undefined
      ? undefined
      : { minPresent, belowMin: spec.presence?.belowMin ?? "continue" };
  const version = spec.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`[${spec.id}] version must be an integer of at least 1.`);
  }

  /** Is `name` one of this game's timers, and is the payload valid for it? */
  const timerPayload = (name: string, raw: unknown): { value: unknown } | undefined => {
    const def = timerDefs?.[name];
    if (!def) return undefined;
    if (!def.validate) return { value: undefined };
    const value = def.validate(raw);
    return value === undefined ? undefined : { value };
  };
  const effectCtx = (now: number): EffectContext => ({
    now,
    validate: validateEvent,
    timerPayload,
  });

  /** Network input: keeps notices the game's own event validators accept, drops the rest. */
  function parseNotices(v: unknown): Notice[] | undefined {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return undefined;
    const notices: Notice[] = [];
    for (const item of v) {
      if (!isRecord(item) || !isInt(item.seq) || typeof item.name !== "string") continue;
      const data = validateEvent(item.name, item.data);
      if (data !== undefined) notices.push({ seq: item.seq, name: item.name, data });
    }
    return notices.slice(-MAX_NOTICES);
  }

  return {
    id: spec.id,
    awayAfterMs: spec.presence?.awayAfterMs,
    hasPrivate: privateSpec !== undefined,
    validatePrivate,

    checkStart(config, lobby, playerCount) {
      if (!modes.includes(lobby.mode)) return `unsupported-mode:${lobby.mode}`;
      if (playerCount < minPlayers) return "too-few-players";
      if (playerCount > maxPlayers) return "too-many-players";
      return spec.validateConfig(config) === undefined ? "invalid-config" : undefined;
    },

    createSlot(round, config, context, names) {
      const validConfig = spec.validateConfig(config);
      if (validConfig === undefined)
        throw new Error(`[${spec.id}] Invalid config at slot creation.`);
      const base: Slot = {
        round,
        stateVersion: version,
        config: validConfig,
        lobby: context.lobby,
        participants: [...context.participants],
        spectators: [],
        away: [],
        paused: false,
        forced: false,
        endRequested: false,
        notices: [],
        noticeSeq: 0,
        timers: {},
        privateRev: {},
        privateSeq: 0,
        names: { ...names },
        teams: { ...context.teams },
        state: null,
      };
      const slot: Slot = {
        ...base,
        state: spec.initialState({ config: validConfig, context: toLobbyContext<M>(base) }),
      };

      const initial = privateSpec?.initial;
      if (!initial) return { slot, writes: [] };
      const patches: Record<string, unknown> = {};
      for (const playerId of slot.participants) {
        const piece = initial({
          playerId,
          state: slot.state as S,
          config: validConfig,
          context: toLobbyContext<M>(slot),
        });
        if (piece !== undefined) patches[playerId] = piece;
      }
      const applied = applyPrivate(slot, patches, privateValidator);
      if (!applied.ok) {
        throw new Error(`[${spec.id}] privateState.initial returned an invalid piece.`);
      }
      return { slot: applied.slot, writes: applied.writes };
    },

    validateSlot(raw) {
      if (raw === null) return null;
      if (!isRecord(raw) || typeof raw.round !== "number" || !Number.isInteger(raw.round))
        return undefined;
      const from = readStateVersion(raw.stateVersion, version);
      if (from === undefined) return undefined; // invalid, or written by a newer build
      const lobby = sanitizeLobbyConfig(raw.lobby);
      const config = spec.validateConfig(
        migrateIfOlder(raw.config, from, version, spec.migrate?.config)
      );
      const state = spec.validateState(
        migrateIfOlder(raw.state, from, version, spec.migrate?.state)
      );
      const participants = strings(raw.participants);
      const spectators = strings(raw.spectators);
      // Absent in slots from an older host: default. Present but malformed: reject.
      const away = raw.away === undefined ? [] : strings(raw.away);
      const names = raw.names === undefined ? {} : parseNames(raw.names);
      const paused = flag(raw.paused);
      const forced = flag(raw.forced);
      const endRequested = flag(raw.endRequested);
      const notices = parseNotices(raw.notices);
      const timers = raw.timers === undefined ? {} : parseTimers(raw.timers, timerPayload);
      const privateRev = parseRevisions(raw.privateRev);
      const seq =
        raw.noticeSeq === undefined
          ? 0
          : isInt(raw.noticeSeq) && raw.noticeSeq >= 0
            ? raw.noticeSeq
            : undefined;
      const privateSeq =
        raw.privateSeq === undefined
          ? 0
          : isInt(raw.privateSeq) && raw.privateSeq >= 0
            ? raw.privateSeq
            : undefined;
      if (!lobby || config === undefined || state === undefined) return undefined;
      if (!participants || !spectators || !away || !names || !isRecord(raw.teams)) {
        return undefined;
      }
      if (paused === undefined || forced === undefined || endRequested === undefined) {
        return undefined;
      }
      if (!notices || !timers || seq === undefined) return undefined;
      if (!privateRev || privateSeq === undefined) return undefined;

      const teams: Record<string, string> = {};
      for (const [playerId, teamId] of Object.entries(raw.teams)) {
        if (typeof teamId === "string") teams[playerId] = teamId;
      }
      return {
        round: raw.round,
        stateVersion: version,
        config,
        lobby,
        participants,
        spectators,
        away,
        paused,
        forced,
        endRequested,
        notices,
        noticeSeq: Math.max(seq, ...notices.map((n) => n.seq)),
        timers,
        privateRev,
        privateSeq: Math.max(privateSeq, ...Object.values(privateRev)),
        names,
        teams,
        state,
      };
    },

    validateEvent,

    installCommands(channel, clock, priv) {
      for (const [name, def] of Object.entries(commands)) {
        channel.handle<unknown>(name, {
          validate: (raw) => def.validate(raw),
          authorize: ({ state, isHostSender, playerId }) => {
            if (!state) return "no-active-game";
            const allow = def.allow ?? "participant";
            if (state.paused && allow !== "host") return "paused";
            if (allow === "host") return isHostSender ? undefined : "host-only";
            if (allow === "participant") {
              return playerId !== undefined && state.participants.includes(playerId)
                ? undefined
                : "not-a-participant";
            }
            return undefined;
          },
          reduce: (slot, payload, { from, playerId }) => {
            if (!slot) return { ok: false, reason: "no-active-game" };
            if (playerId === undefined) return { ok: false, reason: "unknown-sender" };
            const out = def.reduce({
              state: slot.state as S,
              payload,
              config: slot.config as C,
              context: toLobbyContext<M>(slot),
              away: slot.away,
              privateState: asView(priv ? priv.view(slot) : EMPTY_VIEW),
              sender: { peerId: from, playerId },
            });
            if (!out.ok) return out;
            const applied = applyEffects(
              { ...slot, state: out.state },
              out.effects,
              effectCtx(clock.now())
            );
            if (!applied.ok) return applied;
            const pieces = applyPrivate(applied.slot, out.privateState, privateValidator);
            if (!pieces.ok) return { ok: false, reason: "invalid-private" };
            // Before the slot is broadcast, so an owner never sees a revision without its piece.
            priv?.commit(pieces.writes);
            return { ok: true, state: pieces.slot };
          },
        });
      }

      channel.handle<Record<string, never>>(CONTINUE_COMMAND, {
        hostOnly: true,
        validate: () => ({}),
        reduce: (slot) => {
          if (!slot) return { ok: false, reason: "no-active-game" };
          if (!slot.paused) return { ok: false, reason: "not-paused" };
          return { ok: true, state: { ...slot, paused: false, forced: true } };
        },
      });
    },

    lateJoin(slot, playerId) {
      const spectate: Step = {
        slot: { ...slot, spectators: [...slot.spectators, playerId] },
        writes: [],
      };
      if (!spec.onLateJoin) return spectate;

      const decision = spec.onLateJoin({
        state: slot.state as S,
        config: slot.config as C,
        context: toLobbyContext<M>(slot),
        playerId,
        away: slot.away,
        names: slot.names,
      });
      if (!decision) return spectate;

      const replaced = decision.replaces;
      if (replaced !== undefined && !slot.away.includes(replaced)) return spectate;
      if (replaced === undefined && slot.participants.length >= maxPlayers) return spectate;

      let teams = slot.teams;
      if (slot.lobby.mode === "teams") {
        const team = decision.team ?? (replaced !== undefined ? slot.teams[replaced] : undefined);
        if (!team || !slot.lobby.teamIds.includes(team)) return spectate;
        teams = { ...slot.teams, [playerId]: team };
      }
      const joined: Slot = {
        ...slot,
        participants:
          replaced === undefined
            ? [...slot.participants, playerId]
            : slot.participants.map((id) => (id === replaced ? playerId : id)),
        spectators: replaced === undefined ? slot.spectators : [...slot.spectators, replaced],
        away: replaced === undefined ? slot.away : slot.away.filter((id) => id !== replaced),
        teams,
        state: decision.state !== undefined ? decision.state : slot.state,
      };

      // The joiner's piece, and the replaced player's removed.
      const patches: Record<string, unknown> = {};
      if (replaced !== undefined) patches[replaced] = null;
      const piece =
        decision.privateState ??
        privateSpec?.initial?.({
          playerId,
          state: joined.state as S,
          config: joined.config as C,
          context: toLobbyContext<M>(joined),
        });
      if (piece !== undefined) patches[playerId] = piece;
      const applied = applyPrivate(joined, patches, privateValidator);
      return applied.ok ? { slot: applied.slot, writes: applied.writes } : spectate;
    },

    updatePresence(slot, present, expired, removed, now, view) {
      const rejoin = (playerId: string): RejoinStrategy =>
        typeof rejoinRule === "function"
          ? rejoinRule({
              state: slot.state as S,
              config: slot.config as C,
              context: toLobbyContext<M>(slot),
              playerId,
              away: slot.away,
              names: slot.names,
            })
          : rejoinRule;
      const { slot: marked, changes } = computePresence(slot, present, expired, removed, rejoin);
      let next = marked;
      let writes: PrivateWrite[] = [];
      const onChange = spec.presence?.onChange;
      if (changes.length > 0 && onChange) {
        const result = onChange({
          state: marked.state as S,
          config: marked.config as C,
          context: toLobbyContext<M>(marked),
          away: marked.away,
          names: marked.names,
          privateState: asView(view),
          changes,
        });
        if (result instanceof WithEffects) {
          const applied = applyEffects(
            { ...marked, state: result.state as S },
            result.effects as readonly RawEffect[],
            effectCtx(now)
          );
          const pieces = applied.ok
            ? applyPrivate(applied.slot, result.privateState, privateValidator)
            : undefined;
          if (pieces?.ok) {
            next = pieces.slot; // invalid effects or pieces: the whole result is ignored
            writes = pieces.writes;
          }
        } else if (result !== undefined) {
          next = { ...marked, state: result };
        }
      }
      const quorumResult = applyQuorum(next, quorum);
      return { slot: quorumResult.slot, end: quorumResult.end, writes };
    },

    fireTimer(slot, timerId, now, view) {
      const timer = slot.timers[timerId];
      if (!timer || timer.frozenMs !== undefined || slot.paused) return { slot, writes: [] };
      const rest: Slot = { ...slot, timers: withoutTimer(slot.timers, timerId) };
      const consumed: Step = { slot: rest, writes: [] }; // the timer is consumed either way
      const def = timerDefs?.[timer.name];
      if (!def) return consumed;
      const out = def.reduce({
        state: slot.state as S,
        payload: timer.payload,
        config: slot.config as C,
        context: toLobbyContext<M>(slot),
        away: slot.away,
        privateState: asView(view),
      });
      if (!out.ok) return consumed;
      const applied = applyEffects({ ...rest, state: out.state }, out.effects, effectCtx(now));
      if (!applied.ok) return consumed;
      const pieces = applyPrivate(applied.slot, out.privateState, privateValidator);
      return pieces.ok ? { slot: pieces.slot, writes: pieces.writes } : consumed;
    },

    recoverPrivate(slot, view) {
      const recover = privateSpec?.recover;
      if (!recover) return { slot, writes: [] };
      const patches: Record<string, unknown> = {};
      for (const playerId of slot.participants) {
        if (slot.privateRev[playerId] === undefined) continue; // never had a piece
        if (view.get(playerId) !== undefined) continue; // the host holds it
        const piece = recover({
          playerId,
          state: slot.state as S,
          config: slot.config as C,
          context: toLobbyContext<M>(slot),
          away: slot.away,
        });
        if (piece !== undefined) patches[playerId] = piece;
      }
      const applied = applyPrivate(slot, patches, privateValidator);
      return applied.ok ? { slot: applied.slot, writes: applied.writes } : { slot, writes: [] };
    },
  };
}
