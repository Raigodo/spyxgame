// The game feature's factory. Registers the three channels (`game`, `game-events`, `game-private`)
// on the not-yet-started bus, starts the host loop, and returns the GameApi. Disposing `scope`
// stops the loop and every handle's subscriptions. The room starts the bus afterwards.

import { derived, fail, isRecord, ok, s, structurallyEqual, type Scope } from "@/kernel";
import type {
  ActiveGame,
  GameApi,
  GameDef,
  GameDeps,
  GameHandle,
  GameTypes,
  PrivateView,
} from "./model";
import { createGameHandle } from "./handle";
import { startHostFlow } from "./host-flow";
import { GAME_EVENTS_CHANNEL } from "./names";
import { toEndReject, toStartReject } from "./rejects";
import { gamePrivateDef, gameStateDef } from "./state";

const sameActive = (a: ActiveGame | undefined, b: ActiveGame | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.gameId === b.gameId &&
    a.round === b.round &&
    a.supported === b.supported);

export function createGame(deps: GameDeps, scope: Scope): GameApi {
  const { bus, config, inputs, role } = deps;
  const runtimes = new Map(deps.games.map((game) => [game.id, game.runtime] as const));

  // The reducers read the host's private pieces through this, bound once the channel exists.
  let privateView: PrivateView<unknown> = { get: () => undefined };
  const state = bus.state(gameStateDef({ games: deps.games, config, view: () => privateView }));
  const priv = bus.priv(gamePrivateDef({ config }, state));
  privateView = { get: (playerId) => priv.view(playerId) };

  // Events of every game share one channel; the game's own schema runs in its handle.
  const json = s.json({ maxChars: config.maxPieceChars });
  const events = bus.events<unknown>({
    id: GAME_EVENTS_CHANNEL,
    schema: s.custom<unknown>((input) => {
      const checked = json.check(input);
      if (!checked.ok) return checked;
      return isRecord(checked.value) && typeof checked.value.type === "string"
        ? ok(checked.value)
        : fail({ path: "", expected: "event with a type" });
    }),
  });

  startHostFlow(
    {
      role,
      sync: bus.sync,
      value: state.value,
      players: inputs.players,
      removed: inputs.removed,
      state,
      now: () => bus.now(),
      runtimes,
      clock: deps.clock,
      log: deps.log.child("game"),
      config,
    },
    scope
  );

  const handles = new Map<string, GameHandle<GameTypes>>();

  return {
    state: {
      active: derived(
        [state.value] as const,
        (value): ActiveGame | undefined =>
          value?.slot
            ? {
                gameId: value.slot.gameId,
                round: value.round,
                supported: runtimes.has(value.slot.gameId),
              }
            : undefined,
        sameActive
      ),
      last: derived([state.value] as const, (value) => value?.last, structurallyEqual),
      round: derived([state.value] as const, (value) => value?.round),
    },

    actions: {
      start(def, settings) {
        if (role.get() !== "host") return Promise.resolve(fail("not-host"));
        const result = state.apply({
          type: "start",
          gameId: def.id,
          settings,
          setup: inputs.setup.get(),
          seed: deps.entropy.seed(),
        });
        return Promise.resolve(result.ok ? ok() : fail(toStartReject(result.reason)));
      },

      end() {
        if (role.get() !== "host") return Promise.resolve(fail("not-host"));
        const result = state.apply({ type: "end" });
        return Promise.resolve(result.ok ? ok() : fail(toEndReject(result.reason)));
      },

      handle<T extends GameTypes>(def: GameDef<T>) {
        let handle = handles.get(def.id);
        if (!handle) {
          handle = createGameHandle<GameTypes>({
            runtime: def.runtime,
            state,
            priv,
            events,
            role,
            players: inputs.players,
            localPlayerId: deps.localPlayerId,
            roomId: deps.roomId,
            storage: deps.storages.device,
            config,
            scope,
          });
          handles.set(def.id, handle);
        }
        return handle as unknown as GameHandle<T>;
      },
    },
  };
}
