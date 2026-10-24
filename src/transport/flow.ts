import {
  Emitter,
  Scope,
  derived,
  fail,
  listenerFailure,
  logFailure,
  ok,
  prefixed,
  type PeerId,
  type PlayerId,
  type Result,
  type RoomId,
} from "@/kernel";
import { HostClaim } from "./claim/host-claim";
import type { TransportDeps } from "./index";
import { ChunkedMessenger, LinkService, resolveIceServers } from "./link";
import type { DropReason, HandOffReject, JoinError, Transport } from "./model";
import { CLAIM_KEY_PREFIX } from "./names";
import { Relay } from "./relay";
import { SignalingSession } from "./signaling";
import { composeMembers, narrowLinks, sameLinks, sameMembers } from "./view";

export async function joinTransport(
  deps: TransportDeps,
  params: { roomId: RoomId; playerId: PlayerId },
  scope: Scope
): Promise<Result<Transport, JoinError>> {
  const { clock, ids, config, pageLifecycle } = deps;
  const { roomId, playerId } = params;
  const log = deps.log.child("transport");
  const linkConfig = config.link;

  const iceServers = await resolveIceServers({
    source: deps.iceServers,
    clock,
    logger: log.child("ice"),
    fallback: linkConfig.iceServers,
    timeoutMs: linkConfig.iceFetchTimeoutMs,
  });
  if (scope.disposed) return fail("unavailable");

  const self = ids.next() as PeerId;
  const claim = new HostClaim({
    store: prefixed(deps.storages.tab, CLAIM_KEY_PREFIX),
    clock,
    config: linkConfig,
  });

  const session = new SignalingSession({
    membership: deps.membership,
    messages: deps.inbox,
    election: deps.election,
    clock,
    ids,
    logger: log.child("signaling"),
    config: config.signaling,
  });
  const link = new LinkService({
    session,
    connections: deps.connections,
    iceServers,
    clock,
    ids,
    logger: log.child("link"),
    config: linkConfig,
  });
  const messenger = new ChunkedMessenger({
    rtc: link,
    clock,
    ids,
    logger: log.child("chunks"),
    config: linkConfig,
  });

  // Everything the relay and the claim subscribe to lives here, so leave() stops it first.
  const inner = new Scope({ onError: (e) => log.error("Cleanup failed", e) });
  const relay = new Relay(
    {
      messenger,
      self,
      playerId,
      role: link.role,
      host: link.host,
      links: link.links,
      members: session.members,
      clock,
      logger: log.child("relay"),
      maxMessageChars: linkConfig.maxChunkChars * linkConfig.maxChunksPerMessage,
    },
    inner
  );
  messenger.start();

  // The seat is remembered whenever this peer becomes host, including a room creator whose host
  // event fires during join: subscribed before joinRoom.
  inner.add(
    link.host.subscribe(() => {
      if (link.role.get() === "host") claim.remember(roomId, playerId, self);
    })
  );
  // A refresh fires pagehide: stamp the hint so the reloaded tab knows this page is gone.
  inner.add(
    pageLifecycle.onPageHide(() => {
      if (link.isHost()) claim.markLeaving(roomId);
    })
  );

  const dropped = new Emitter<DropReason>(listenerFailure(() => log));

  let leavePromise: Promise<void> | undefined;
  const leave = (): Promise<void> => {
    leavePromise ??= (async () => {
      claim.forget(roomId); // a deliberate leave or a drop never reclaims
      inner.dispose();
      messenger.stop();
      await link.leaveRoom();
    })();
    return leavePromise;
  };

  // A told guest never suspects the host: it leaves at once, so the later link close is ignored.
  inner.add(
    relay.byeReceived.on((reason) => {
      dropped.emit(reason);
      void leave().catch(logFailure(log, "leave after bye"));
    })
  );

  try {
    await link.joinRoom(roomId, self, { formerHost: claim.recall(roomId, playerId) });
  } catch (error) {
    log.warn("Join failed", error);
    await leave().catch(logFailure(log, "leave after failed join"));
    return fail("unavailable");
  }

  const links = derived(
    [link.role, link.host, link.links],
    (role, host, all) => narrowLinks(role, host, all),
    sameLinks
  );
  const members = derived(
    [link.role, session.members, relay.bindings],
    (role, all, bindings) => composeMembers(role, all, bindings),
    sameMembers
  );

  const transport: Transport = {
    self,
    role: link.role,
    host: link.host,
    members,
    links,
    send: (to, msg) => relay.send(to, msg),
    broadcast: (msg) => relay.broadcast(msg),
    messages: relay.messages,
    dropped,
    async drop(peer, reason) {
      if (link.role.get() !== "host" || peer === self) return;
      relay.sendBye(peer, reason);
      // Closing right away can discard the unsent bye: give it time to drain first.
      await new Promise<void>((resolve) => {
        clock.after(linkConfig.byeFlushMs, resolve);
      });
      await link.removePeer(peer);
    },
    async handOff(to): Promise<Result<void, HandOffReject>> {
      const result = await link.transferHost(to);
      return result === "transferred" ? ok() : fail(result);
    },
    leave,
  };

  // Joining is tied to the scope. If it was disposed during the join, this leaves at once.
  scope.add(() => void leave().catch(logFailure(log, "leave on dispose")));
  return ok(transport);
}
