import { describe, expect, it } from "vitest";
import { FakeFirestoreState } from "@/shared/testing/fake-firestore-state";
import { FakeRoomMembership } from "@/shared/testing/fake-room-membership";
import { FakeSignalInbox } from "@/shared/testing/fake-signal-inbox";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { PeerRemover, shouldClearInbox } from "./peer-remover";

const message = {
  id: "m1",
  fromPeerId: "a",
  toPeerId: "dead",
  timestamp: new Date(0),
  payload: null,
};

async function setup(failMembership = false) {
  const state = new FakeFirestoreState();
  const membership = new FakeRoomMembership(state);
  if (failMembership) membership.removePeer = () => Promise.reject(new Error("boom"));
  const messages = new FakeSignalInbox(state);
  const logger = new RecordingLogger();
  await new FakeRoomMembership(state).addPeer("r", "dead", new Date(0));
  await messages.addMessage("r", message);
  const remover = new PeerRemover({ membership, messages, logger, roomId: "r" });
  return { state, remover, messages, logger };
}

describe("shouldClearInbox", () => {
  it("skips only the ack-timeout case", () => {
    expect(shouldClearInbox("ack-timeout")).toBe(false);
    for (const r of ["suspected-dead", "host-removed", "reclaim"] as const) {
      expect(shouldClearInbox(r)).toBe(true);
    }
  });
});

describe("PeerRemover", () => {
  it("removes membership and clears the inbox", async () => {
    const { state, remover, messages } = await setup();
    await remover.remove("dead", "host-removed");
    expect(state.room("r").peers.has("dead")).toBe(false);
    expect(await messages.messageExists("r", "dead", "m1")).toBe(false);
  });

  it("leaves the inbox alone after an ack timeout", async () => {
    const { state, remover, messages } = await setup();
    await remover.remove("dead", "ack-timeout");
    expect(state.room("r").peers.has("dead")).toBe(false);
    expect(await messages.messageExists("r", "dead", "m1")).toBe(true);
  });

  it("rejects when the membership delete fails, but still clears the inbox", async () => {
    const { remover, messages } = await setup(true);
    await expect(remover.remove("dead", "suspected-dead")).rejects.toThrow("boom");
    expect(await messages.messageExists("r", "dead", "m1")).toBe(false);
  });

  it("counts removals by reason", async () => {
    const { remover } = await setup();
    await remover.remove("dead", "reclaim");
    await remover.remove("dead", "reclaim");
    await remover.remove("dead", "suspected-dead");
    expect(remover.inspect()).toMatchObject({ reclaim: 2, "suspected-dead": 1, "ack-timeout": 0 });
  });
});
