import { expect, it, vi } from "vitest";
import { FakeClock } from "@/shared/testing/fake-clock";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import type { ChunkedMessenger, RtcTransport } from "../webrtc";
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
  const rtc: RtcTransport = {
    joinRoom: vi.fn(async () => {}),
    leaveRoom: vi.fn(async () => {}),
    removePeer: vi.fn(async () => {}),
    transferHost: vi.fn(async () => "transferred" as const),
    inspect: () => ({}),
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
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const session = new PlayerSession({
    clock,
    rtc,
    messenger: messenger as unknown as ChunkedMessenger,
    logger,
  });
  return {
    session,
    clock,
    logger,
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

it("stamps the local profile with the injected clock", async () => {
  const { session, clock } = setup();
  clock.advance(1_234);
  await session.join("room", { nickname: "H" });
  expect(session.getLocalPlayer()?.updatedAt).toBe(1_234);

  clock.advance(100);
  session.updateLocalProfile({ nickname: "H2" });
  expect(session.getLocalPlayer()?.updatedAt).toBe(1_334);
});

it("warns about a malformed message with the sender, throttled per sender", async () => {
  const { session, receive, logger, clock } = setup();
  await session.join("room", { nickname: "H" });

  receive("not json", "g1");
  receive("not json", "g1");
  expect(logger.entries.filter((e) => e.level === "warn")).toHaveLength(1);
  expect(logger.entries.find((e) => e.level === "warn")?.data).toEqual({ from: "g1" });

  clock.advance(5_000);
  receive("not json", "g1");
  const warns = logger.entries.filter((e) => e.level === "warn");
  expect(warns).toHaveLength(2);
  expect(warns[1]?.data).toEqual({ from: "g1", suppressed: 1 });
});
