import { expect, it, vi } from "vitest";
import { NullLogger } from "@/shared/kernel";
import type { ChunkedMessenger, WebRtcService } from "../webrtc";
import { PlayerSession } from "./player-session";

function setup() {
  let onMessage: (raw: string, from: string) => void = () => {};
  let onPeerLeft: (peer: { signalingPeerId: string }) => void = () => {};
  const messenger = {
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: (handler: (raw: string, from: string) => void) => {
      onMessage = handler;
      return () => {};
    },
    broadcast: vi.fn(),
    sendToPeer: vi.fn(),
  };
  const rtc = {
    joinRoom: vi.fn(async () => {}),
    leaveRoom: vi.fn(async () => {}),
    getLocalPeerId: () => "host-1",
    getHostPeerId: () => "host-1",
    isHost: () => true,
    getPeers: () => [],
    getMemberPeerIds: () => [],
    onPeerLeft: (handler: (peer: { signalingPeerId: string }) => void) => {
      onPeerLeft = handler;
      return () => {};
    },
    onHostChanged: () => () => {},
    onPeerStatusChanged: () => () => {},
  };
  const session = new PlayerSession({
    rtc: rtc as unknown as WebRtcService,
    messenger: messenger as unknown as ChunkedMessenger,
    logger: new NullLogger(),
  });
  return {
    session,
    messenger,
    receive: (raw: string, from: string) => onMessage(raw, from),
    leave: (id: string) => onPeerLeft({ signalingPeerId: id }),
  };
}

const profile = (peerId: string) =>
  JSON.stringify({
    kind: "profile",
    profile: { peerId, nickname: "G", metadata: {}, updatedAt: 1 },
  });

it("removes a leaving peer and broadcasts the roster once, even if the leave is reported twice", async () => {
  const { session, messenger, receive, leave } = setup();
  await session.join("room", { nickname: "H" });
  receive(profile("g1"), "g1");
  expect(session.getPlayers().map((p) => p.peerId)).toEqual(["host-1", "g1"]);

  messenger.broadcast.mockClear();
  leave("g1");
  leave("g1");

  expect(session.getPlayers().map((p) => p.peerId)).toEqual(["host-1"]);
  expect(messenger.broadcast).toHaveBeenCalledTimes(1);
});
