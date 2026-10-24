// The replicated roster: channel definitions and the bus reducers (thin wrappers over rules.ts).

import { fail, ok, type PlayerId, type Result } from "@/kernel";
import type { Bus, CmdCtx, CommandSpec, EventDef, EventHandle, StateDef, StateHandle } from "@/bus";
import type { RosterConfig } from "./config";
import { CHANNELS } from "./names";
import {
  createRosterSchemas,
  type RosterCommand,
  type RosterEvent,
  type RosterReject,
  type RosterState,
} from "./model";
import {
  EMPTY_ROSTER,
  applyBan,
  applyJoin,
  applyRemove,
  applyRename,
  applySync,
  applyUnban,
  type Actor,
  type Outcome,
} from "./rules";

export type RosterStateHandle = StateHandle<RosterState, RosterCommand, RosterReject>;
export type RosterEventsHandle = EventHandle<RosterEvent>;

type Reduced = ReturnType<CommandSpec<RosterState, RosterCommand, RosterReject>["reduce"]>;

/** The one place that adapts a rules Outcome to the bus's reducer result. */
const lift = (outcome: Outcome): Reduced => (outcome.ok ? ok({ state: outcome.value }) : outcome);

/** The verified sender as a rules Actor. The host's own commands carry its local player id. */
function actorOf(ctx: CmdCtx, localPlayerId: PlayerId): Actor | undefined {
  const playerId = ctx.playerId ?? (ctx.fromHost ? localPlayerId : undefined);
  return playerId ? { from: ctx.from, playerId, now: ctx.now } : undefined;
}

export interface RosterChannelDeps {
  bus: Bus;
  localPlayerId: PlayerId;
  config: Pick<RosterConfig, "maxPlayers" | "maxNameLength" | "banLimit" | "departureGraceMs">;
}

/** Registers both channels. Call before `bus.start()`. */
export function registerRosterChannels(deps: RosterChannelDeps): {
  state: RosterStateHandle;
  events: RosterEventsHandle;
} {
  const { config, localPlayerId } = deps;
  const schemas = createRosterSchemas(config);

  // A command from a sender the transport has no player for is invalid, never trusted.
  const withActor =
    <P>(run: (state: RosterState, payload: P, actor: Actor) => Outcome) =>
    (state: RosterState, payload: P, ctx: CmdCtx): Reduced => {
      const actor = actorOf(ctx, localPlayerId);
      return actor ? lift(run(state, payload, actor)) : fail("invalid");
    };

  type Cmd<K extends RosterCommand["type"]> = Extract<RosterCommand, { type: K }>;

  const stateDef: StateDef<RosterState, RosterCommand, RosterReject> = {
    id: CHANNELS.roster,
    schema: schemas.state,
    init: EMPTY_ROSTER,
    commands: {
      join: {
        who: "anyone",
        schema: schemas.commands.join,
        reduce: withActor<Cmd<"join">>((s, p, a) => applyJoin(s, p.name, a, config)),
      },
      rename: {
        who: "anyone",
        schema: schemas.commands.rename,
        reduce: withActor<Cmd<"rename">>((s, p, a) => applyRename(s, p.name, a)),
      },
      sync: {
        who: "host",
        schema: schemas.commands.sync,
        reduce: (state, payload, ctx) =>
          ok({ state: applySync(state, payload.links, ctx, config.departureGraceMs) }),
      },
      remove: {
        who: "host",
        schema: schemas.commands.remove,
        reduce: withActor<Cmd<"remove">>((s, p, a) => applyRemove(s, p.playerId, a)),
      },
      ban: {
        who: "host",
        schema: schemas.commands.ban,
        reduce: withActor<Cmd<"ban">>((s, p, a) => applyBan(s, p.playerId, a, config)),
      },
      unban: {
        who: "host",
        schema: schemas.commands.unban,
        reduce: withActor<Cmd<"unban">>((s, p) => applyUnban(s, p.playerId)),
      },
    },
  };
  const eventDef: EventDef<RosterEvent> = { id: CHANNELS.events, schema: schemas.event };

  return { state: deps.bus.state(stateDef), events: deps.bus.events(eventDef) };
}

// Re-exported for host-flow and tests that need the result type of a send.
export type RosterSendResult = Result<void, RosterReject>;
