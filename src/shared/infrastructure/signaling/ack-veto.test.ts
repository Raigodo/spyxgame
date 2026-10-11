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
import { SignalingSession } from "./signaling-session";

const config = createConfig().signaling;

async function setup() {
  const state = new FakeFirestoreState();
  const membership = new FakeRoomMembership(state);
  const clock = new FakeClock();
  const session = new SignalingSession({
    membership,
    messages: new FakeSignalInbox(state),
    election: new FakeHostElection(state),
    clock,
    ids: new FakeIds(),
    logger: new RecordingLogger(),
    config,
  });
  await session.joinRoom("r", "me");
  await membership.addPeer("r", "other", new Date(1));
  await nextMacrotask();
  await session.sendSignal("other", { type: "offer", sdp: "sdp" }, "remove", {
    requireMember: true,
  }); // nobody reads other's inbox
  return { state, session, clock };
}

describe("ack timeout veto", () => {
  it("removes an unresponsive peer by default", async () => {
    const { state, clock } = await setup();
    clock.advance(config.ackTimeoutMs);
    await vi.waitFor(() => expect(state.room("r").peers.has("other")).toBe(false));
  });

  it("keeps the peer when the veto says it is alive", async () => {
    const { state, session, clock } = await setup();
    const veto = vi.fn(() => true);
    session.setAckTimeoutVeto(veto);
    clock.advance(config.ackTimeoutMs);
    await vi.waitFor(() => expect(veto).toHaveBeenCalledWith("other"));
    await nextMacrotask();
    expect(state.room("r").peers.has("other")).toBe(true);
  });
});
