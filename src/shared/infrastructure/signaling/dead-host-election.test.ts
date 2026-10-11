import { describe, expect, it } from "vitest";
import { createConfig } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { FakeFirestoreState } from "@/shared/testing/fake-firestore-state";
import { FakeHostElection } from "@/shared/testing/fake-host-election";
import { FakeRoomMembership } from "@/shared/testing/fake-room-membership";
import { FakeSignalInbox } from "@/shared/testing/fake-signal-inbox";
import { nextMacrotask } from "@/shared/testing/next-macrotask";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { DeadHostElection } from "./dead-host-election";
import { PeerRemover } from "./peer-remover";

const config = createConfig().signaling;

async function setup(peers: string[]) {
  const state = new FakeFirestoreState();
  const membership = new FakeRoomMembership(state);
  const election = new FakeHostElection(state);
  const logger = new RecordingLogger();
  const clock = new FakeClock();
  for (const [i, id] of peers.entries()) await membership.addPeer("r", id, new Date(i));
  await election.writeHost("r", "dead");
  const remover = new PeerRemover({
    membership,
    messages: new FakeSignalInbox(state),
    logger,
    roomId: "r",
  });
  const dead = new DeadHostElection({
    membership,
    election,
    remover,
    clock,
    logger,
    config,
    roomId: "r",
    localPeerId: "me",
  });
  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      clock.advance(100);
      await nextMacrotask();
    }
  };
  return { state, election, dead, run };
}

describe("DeadHostElection", () => {
  it("a cancel before the window ends removes nobody and leaves the host document alone", async () => {
    const { state, dead, run } = await setup(["dead", "me"]);
    dead.report("dead");
    await nextMacrotask();
    await run(config.candidateCollectionWindowMs - 200);
    dead.cancel();
    await run(10_000);
    expect(state.room("r").peers.has("dead")).toBe(true);
    expect(state.room("r").host?.signalingPeerId).toBe("dead");
    expect(dead.getSuspected()).toBeUndefined();
  });

  it("removes the host at the end of the window, confirms, and claims the seat", async () => {
    const { state, dead, run } = await setup(["dead", "me"]);
    dead.report("dead");
    await nextMacrotask();
    await run(config.candidateCollectionWindowMs + config.candidateConfirmWindowMs + 500);
    expect(state.room("r").peers.has("dead")).toBe(false);
    expect(state.room("r").host?.signalingPeerId).toBe("me");
    expect(dead.getSuspected()).toBeUndefined();
  });

  it("ignores a candidate that never confirmed, so it costs no turn", async () => {
    // "a" sorts before "me" and is alive in membership, but only registered, never confirmed.
    const { state, election, dead, run } = await setup(["dead", "a", "me"]);
    await election.registerCandidate("r", "a", "dead", "registered");
    dead.report("dead");
    await nextMacrotask();
    await run(config.candidateCollectionWindowMs + config.candidateConfirmWindowMs + 300);
    expect(state.room("r").host?.signalingPeerId).toBe("me");
  });

  it("does not restart the window for a repeated report of the same host", async () => {
    const { state, dead, run } = await setup(["dead", "me"]);
    dead.report("dead");
    await nextMacrotask();
    await run(config.candidateCollectionWindowMs - 500);
    dead.report("dead");
    await run(1_500);
    expect(state.room("r").peers.has("dead")).toBe(false);
  });
});
