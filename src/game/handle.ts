// A GameHandle: what one game's UI talks to. Built lazily, once per game, by createGame. Thin shell
// over the game channel: the atomic `view`, `send` (the one `play` command), ephemeral `events`,
// state `noticed`, host `continueAnyway` and device-local state. Decisions live in view.ts and
// rejects.ts.

import type { BusFailure, EventHandle, PrivateHandle, StateHandle } from "@/bus";
import {
  Emitter,
  derived,
  fail,
  ok,
  structurallyEqual,
  type KeyValueStore,
  type Listenable,
  type PeerId,
  type PlayerId,
  type Result,
  type RoomId,
  type Scope,
  type Store,
} from "@/kernel";
import type { GameConfig } from "./config";
import { createLocalState } from "./local-state";
import type {
  ContinueReject,
  GameCommand,
  GameHandle,
  GameRuntime,
  GameState,
  GameTypes,
  InputPlayer,
  LocalStateDef,
  PlayError,
} from "./model";
import { toContinueReject } from "./rejects";
import { buildView, diffNotices, type NoticeCursor } from "./view";

export type HandleDeps = {
  runtime: GameRuntime;
  state: StateHandle<GameState, GameCommand, string>;
  priv: PrivateHandle<unknown>;
  events: EventHandle<unknown>;
  role: Store<"guest" | "host">;
  players: Store<readonly InputPlayer[]>;
  localPlayerId: PlayerId;
  roomId: RoomId;
  /** `Storages.device`. */
  storage: KeyValueStore;
  config: GameConfig;
  scope: Scope;
};

export function createGameHandle<T extends GameTypes>(deps: HandleDeps): GameHandle<T> {
  const { runtime, state, priv, scope } = deps;
  const gameId = runtime.id;

  /** This game is the active one and the channel is synced. */
  const isActive = (): boolean => state.synced.get() && state.value.get()?.slot?.gameId === gameId;

  const view = derived(
    [state.value, state.synced, priv.mine] as const,
    (value, synced, mine) =>
      buildView<T>({ runtime, playerId: deps.localPlayerId, state: value, synced, mine }),
    structurallyEqual
  );

  // Ephemeral events: dropped unless this game is active and the game's own schema accepts them.
  const eventEmitter = new Emitter<{ event: T["event"]; from: PeerId }>();
  scope.on(deps.events.events, ({ event, from }) => {
    if (!isActive()) return;
    const parsed = runtime.parseEvent(event);
    if (parsed) eventEmitter.emit({ event: parsed.value as T["event"], from });
  });

  // Notices come from state, so every peer sees each once. The first sight is a baseline.
  const noticeEmitter = new Emitter<{ event: T["event"] }>();
  let cursor: NoticeCursor;
  scope.watch(state.value, (value) => {
    const diff = diffNotices(cursor, value, gameId);
    cursor = diff.cursor;
    for (const event of diff.events) noticeEmitter.emit({ event: event as T["event"] });
  });
  const noticed: Listenable<T["event"]> = {
    on: (fn) => noticeEmitter.on(({ event }) => fn(event)),
  };

  const activeRound = derived([state.value] as const, (value) =>
    value?.slot?.gameId === gameId ? value.round : undefined
  );
  const locals = new Map<string, { value: Store<unknown>; set(next: unknown): void }>();

  /** A checked event, or undefined when it must not be sent. */
  const outgoing = (event: T["event"]): { value: unknown } | undefined =>
    isActive() ? runtime.parseEvent(event) : undefined;

  return {
    view,
    events: eventEmitter,
    noticed,

    send(command) {
      return state.send({ type: "play", gameId, command }) as unknown as Promise<
        Result<void, T["reject"] | PlayError | BusFailure>
      >;
    },

    broadcast(event) {
      const checked = outgoing(event);
      if (!checked) return false;
      deps.events.broadcast(checked.value);
      return true;
    },

    sendTo(id, event) {
      const checked = outgoing(event);
      const peer = deps.players.get().find((p) => p.id === id)?.peerId;
      if (!checked || peer === undefined) return false;
      deps.events.sendTo(peer, checked.value);
      return true;
    },

    continueAnyway(): Promise<Result<void, ContinueReject>> {
      if (deps.role.get() !== "host") return Promise.resolve(fail("not-host"));
      if (!isActive()) return Promise.resolve(fail("not-paused"));
      const result = state.apply({ type: "continue" });
      return Promise.resolve(result.ok ? ok() : fail(toContinueReject(result.reason)));
    },

    local<L>(def: LocalStateDef<L>) {
      const existing = locals.get(def.id);
      if (existing) return existing as { value: Store<L>; set(next: L): void };
      const created = createLocalState<L>(
        {
          storage: deps.storage,
          roomId: deps.roomId,
          gameId,
          playerId: deps.localPlayerId,
          round: activeRound,
          config: deps.config,
        },
        def
      );
      locals.set(def.id, created as { value: Store<unknown>; set(next: unknown): void });
      return created;
    },
  };
}
