// The roster's composition root: wires channels, view, flows and moderation onto one scope.
// Call before `bus.start()` (channels must be registered first). Teardown is the scope's: the
// flows registered last are stopped first.

import { fail, ok, type Result, type Scope } from "@/kernel";
import type { BusFailure } from "@/bus";
import { GuestFlow } from "./guest-flow";
import { HostFlow } from "./host-flow";
import { Moderation } from "./moderation";
import type { Roster, RosterDeps } from "./model";
import { openProfile, pickName } from "./profile-store";
import { registerRosterChannels } from "./state";
import { createChangeEvents, createRosterView } from "./view";

type RenameError = "invalid" | "unknown-player" | BusFailure;

/** Pure: a send failure as the public rename error. */
function toRenameError(reason: string): RenameError {
  return reason === "unknown-player" || reason === "expired" || reason === "left"
    ? reason
    : "invalid";
}

export function createRoster(deps: RosterDeps, scope: Scope): Roster {
  const { transport, bus, localPlayerId, clock, log, config } = deps;

  const { state, events } = registerRosterChannels({ bus, localPlayerId, config });

  const profile = openProfile(deps.storages.profile, config.profileTtlMs);
  let nickname = pickName(
    deps.nickname,
    profile.loadName(),
    config.defaultName,
    config.maxNameLength
  );
  const getName = (): string => nickname;

  const view = createRosterView({
    value: state.value,
    localPlayerId,
    selfPeerId: transport.self,
    hostPeerId: transport.host,
  });
  const changes = createChangeEvents(log.child("events"));
  scope.add(changes.watch(view.loaded));

  const hostFlow = new HostFlow({
    transport,
    bus,
    state,
    events,
    localPlayerId,
    getName,
    clock,
    log: log.child("host"),
    config,
  });
  const guestFlow = new GuestFlow({
    transport,
    bus,
    state,
    events,
    localPlayerId,
    getName,
    clock,
    log: log.child("guest"),
    config,
  });
  const moderation = new Moderation({
    transport,
    bus,
    state,
    localPlayerId,
    log: log.child("moderation"),
  });
  scope.add(hostFlow.start());
  scope.add(guestFlow.start());

  return {
    state: { players: view.players, me: view.me, host: view.host, bans: view.bans },
    actions: {
      async rename(name): Promise<Result<void, RenameError>> {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > config.maxNameLength) return fail("invalid");
        const result = await state.send({ type: "rename", name: trimmed });
        if (!result.ok) return fail(toRenameError(result.reason));
        nickname = trimmed;
        profile.saveName(trimmed);
        return ok(undefined);
      },
      kick: (id) => moderation.kick(id),
      ban: (id) => moderation.ban(id),
      unban: (id) => moderation.unban(id),
      handOff: (id) => moderation.handOff(id),
    },
    events: {
      joined: changes.joined,
      rejoined: changes.rejoined,
      left: changes.left,
      refused: guestFlow.refusal,
    },
  };
}
