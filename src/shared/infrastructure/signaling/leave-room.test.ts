import { describe, expect, it } from "vitest";
import { createConfig } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { FakeFirestoreState } from "@/shared/testing/fake-firestore-state";
import { FakeHostElection } from "@/shared/testing/fake-host-election";
import { FakeIds } from "@/shared/testing/fake-ids";
import { FakeRoomMembership } from "@/shared/testing/fake-room-membership";
import { FakeSignalInbox } from "@/shared/testing/fake-signal-inbox";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { SignalingSession } from "./signaling-session";

const boom = () => Promise.reject(new Error("boom"));

class FailingInbox extends FakeSignalInbox {
  override clearInbox = boom;
}
class FailingElection extends FakeHostElection {
  override getHost = boom;
}
class FailingMembership extends FakeRoomMembership {
  override removePeer = boom;
}

function setup(parts: {
  messages?: (s: FakeFirestoreState) => FakeSignalInbox;
  election?: (s: FakeFirestoreState) => FakeHostElection;
  membership?: (s: FakeFirestoreState) => FakeRoomMembership;
}) {
  const state = new FakeFirestoreState();
  const logger = new RecordingLogger();
  const session = new SignalingSession({
    membership: parts.membership?.(state) ?? new FakeRoomMembership(state),
    messages: parts.messages?.(state) ?? new FakeSignalInbox(state),
    election: parts.election?.(state) ?? new FakeHostElection(state),
    clock: new FakeClock(),
    ids: new FakeIds(),
    logger,
    config: createConfig().signaling,
  });
  return { state, logger, session };
}

describe("SignalingSession.leaveRoom", () => {
  it("removes membership even when clearing the inbox fails", async () => {
    const { state, logger, session } = setup({ messages: (s) => new FailingInbox(s) });
    await session.joinRoom("r", "me");
    await session.leaveRoom();
    expect(state.room("r").peers.has("me")).toBe(false);
    expect(session.peerId).toBeUndefined();
    expect(logger.messages("warn")).toContain("clear own inbox failed");
  });

  it("removes membership even when reading the host document fails", async () => {
    const { state, logger, session } = setup({ election: (s) => new FailingElection(s) });
    await session.joinRoom("r", "me");
    await session.leaveRoom();
    expect(state.room("r").peers.has("me")).toBe(false);
    expect(logger.messages("warn")).toContain("release host seat failed");
  });

  it("does not throw when the membership removal itself fails, and still resets state", async () => {
    const { logger, session } = setup({ membership: (s) => new FailingMembership(s) });
    await session.joinRoom("r", "me");
    await expect(session.leaveRoom()).resolves.toBeUndefined();
    expect(session.peerId).toBeUndefined();
    expect(session.roomId).toBeUndefined();
    expect(logger.messages("warn")).toContain("remove own membership failed");
  });

  it("is idempotent", async () => {
    const { session } = setup({});
    await session.joinRoom("r", "me");
    await session.leaveRoom();
    await expect(session.leaveRoom()).resolves.toBeUndefined();
  });
});
