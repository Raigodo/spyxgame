import { describe, expect, it } from "vitest";
import { RecordingLogger } from "@/kernel/fakes";
import { PeerRemover, shouldClearInbox } from "./peer-remover";
import { FakeFirestoreState, FakeRoomMembership, FakeSignalInbox } from "./fakes";

const ROOM = "r1";

async function setup() {
  const state = new FakeFirestoreState();
  const membership = new FakeRoomMembership(state);
  const messages = new FakeSignalInbox(state);
  await membership.addPeer(ROOM, "p1", new Date(1));
  state.inbox(ROOM, "p1").set("m1", {
    id: "m1",
    fromPeerId: "x",
    toPeerId: "p1",
    timestamp: new Date(1),
    payload: {},
  });
  const remover = new PeerRemover({
    membership,
    messages,
    logger: new RecordingLogger(),
    roomId: ROOM,
  });
  return { state, remover };
}

describe("shouldClearInbox", () => {
  it("is false only for an ack timeout", () => {
    expect(shouldClearInbox("ack-timeout")).toBe(false);
    for (const r of ["suspected-dead", "host-removed", "reclaim"] as const) {
      expect(shouldClearInbox(r)).toBe(true);
    }
  });
});

describe("PeerRemover", () => {
  it("removes membership and clears the inbox, and counts the reason", async () => {
    const { state, remover } = await setup();
    await remover.remove("p1", "suspected-dead");
    expect(state.room(ROOM).peers.has("p1")).toBe(false);
    expect(state.inbox(ROOM, "p1").size).toBe(0);
    expect(remover.inspect()).toMatchObject({ "suspected-dead": 1, "ack-timeout": 0 });
  });
  it("leaves the inbox alone after an ack timeout", async () => {
    const { state, remover } = await setup();
    await remover.remove("p1", "ack-timeout");
    expect(state.room(ROOM).peers.has("p1")).toBe(false);
    expect(state.inbox(ROOM, "p1").size).toBe(1);
  });
  it("removing an unknown peer is harmless", async () => {
    const { remover } = await setup();
    await expect(remover.remove("ghost", "host-removed")).resolves.toBeUndefined();
  });
});
