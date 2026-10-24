// The only way into a room. One Scope owns everything: transport, bus, features. Disposal runs
// features first, then the bus, then the transport.

import { Cell, Scope, fail, logFailure, ok, type PlayerId, type Result } from "@/kernel";
import { createBus } from "@/bus";
import { createRoster } from "@/roster";
import { joinTransport, type JoinError } from "@/transport";
import { describeRoom } from "./debug";
import type { JoinRoomParams, JoinedRoom, Room, RoomDeps, RoomEnd } from "./model";

export async function joinRoom(
  deps: RoomDeps,
  params: JoinRoomParams
): Promise<Result<JoinedRoom, JoinError>> {
  const { ids, clock, config } = deps;
  const log = deps.log.child("room");
  const generated = params.playerId === undefined;
  const playerId = params.playerId ?? (ids.next() as PlayerId);

  const scope = new Scope({ onError: (e) => log.error("Cleanup failed", e) });

  const joined = await joinTransport(
    {
      clock,
      ids,
      log: deps.log,
      storages: deps.storages,
      pageLifecycle: deps.pageLifecycle,
      membership: deps.membership,
      inbox: deps.inbox,
      election: deps.election,
      connections: deps.connections,
      iceServers: deps.iceServers,
      config: { signaling: config.signaling, link: config.link },
    },
    { roomId: params.roomId, playerId },
    scope
  );
  if (!joined.ok) {
    scope.dispose();
    return fail(joined.reason);
  }
  const transport = joined.value;

  const ended = new Cell<RoomEnd | undefined>(undefined);
  let leaving: Promise<void> | undefined;
  const leave = (): Promise<void> => {
    leaving ??= (async () => {
      scope.dispose();
      await transport.leave();
    })();
    return leaving;
  };
  const end = (reason: RoomEnd["reason"]): void => {
    if (ended.get()) return;
    ended.set({ reason });
    void leave().catch(logFailure(log, "leave after the room ended"));
  };

  // Subscribed before anything else is built, so a drop is never missed.
  scope.on(transport.dropped, (reason) => end(reason));

  const bus = createBus(
    {
      transport,
      localPlayerId: playerId,
      clock,
      ids,
      log: deps.log.child("bus"),
      config: config.bus,
    },
    scope
  );
  const roster = createRoster(
    {
      transport,
      bus,
      localPlayerId: playerId,
      ...(params.nickname !== undefined ? { nickname: params.nickname } : {}),
      clock,
      ids,
      log: deps.log.child("roster"),
      storages: deps.storages,
      config: config.roster,
    },
    scope.child()
  );
  scope.on(roster.events.refused, (reason) => end(reason === "banned" ? "kicked" : "full"));
  bus.start();

  const room: Room = {
    roomId: params.roomId,
    playerId,
    self: transport.self,
    role: transport.role,
    sync: bus.sync,
    ended,
    roster,
    leave,
    debug: () =>
      describeRoom({
        roomId: params.roomId,
        playerId,
        self: transport.self,
        sync: bus.sync,
        ended,
        transport,
        roster,
      }),
  };
  return ok({ room, generated });
}
