import { describe, expect, it, vi } from "vitest";
import { createConfig } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { FakeFirestoreState } from "@/shared/testing/fake-firestore-state";
import { FakeHostElection } from "@/shared/testing/fake-host-election";
import { FakeIds } from "@/shared/testing/fake-ids";
import { FakeRoomMembership } from "@/shared/testing/fake-room-membership";
import { FakeSignalInbox } from "@/shared/testing/fake-signal-inbox";
import { nextMacrotask } from "@/shared/testing/next-macrotask";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { HostElectionService } from "./host-election-service";
import { SignalingSession } from "./signaling-session";

const config = createConfig().signaling;

describe("HostElectionService.onHostChanged", () => {
  it("unsubscribing one handler leaves the others subscribed", async () => {
    const state = new FakeFirestoreState();
    const election = new FakeHostElection(state);
    const service = new HostElectionService({
      membership: new FakeRoomMembership(state),
      election,
      messages: new FakeSignalInbox(state),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
      config,
      roomId: "r",
      localPeerId: "me",
    });
    service.start();
    const a = vi.fn();
    const b = vi.fn();
    const offA = service.onHostChanged(a);
    service.onHostChanged(b);
    await nextMacrotask();
    a.mockClear();
    b.mockClear();

    offA();
    await election.writeHost("r", "p2");
    await nextMacrotask();

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ signalingPeerId: "p2" });
    service.stop();
  });
});

describe("SignalingSession.onSignalReceived", () => {
  it("unsubscribing one handler leaves the others subscribed", async () => {
    const state = new FakeFirestoreState();
    const inbox = new FakeSignalInbox(state);
    const session = new SignalingSession({
      membership: new FakeRoomMembership(state),
      messages: inbox,
      election: new FakeHostElection(state),
      clock: new FakeClock(),
      ids: new FakeIds(),
      logger: new RecordingLogger(),
      config,
    });
    await session.joinRoom("r", "me");
    const a = vi.fn();
    const b = vi.fn();
    const offA = session.onSignalReceived(a);
    session.onSignalReceived(b);

    const send = (id: string) =>
      inbox.addMessage("r", {
        id,
        fromPeerId: "other",
        toPeerId: "me",
        timestamp: new Date(0),
        payload: { type: "offer", sdp: "x" },
      });

    await send("m1");
    await nextMacrotask();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    await send("m2");
    await nextMacrotask();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    await session.leaveRoom();
  });
});
