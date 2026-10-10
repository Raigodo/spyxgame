import { describe, expect, it, vi } from "vitest";
import type { SignalingMessage } from "@/shared/infrastructure/signaling";
import { FakeFirestoreState } from "./fake-firestore-state";
import { FakeHostElection } from "./fake-host-election";
import { FakePortLife } from "./fake-port-life";
import { FakeRoomMembership } from "./fake-room-membership";
import { FakeSignalInbox } from "./fake-signal-inbox";
import { nextMacrotask } from "./next-macrotask";

const message = (id: string): SignalingMessage => ({
  id,
  fromPeerId: "a",
  toPeerId: "b",
  timestamp: new Date(0),
  payload: null,
});

describe("fake Firestore ports", () => {
  it("peers: initial snapshot, then changes, ordered by joinedAt", async () => {
    const membership = new FakeRoomMembership(new FakeFirestoreState());
    const seen: string[][] = [];
    membership.subscribeToPeers("r", (peers) => seen.push(peers.map((p) => p.peerId)));
    await nextMacrotask();
    expect(seen).toEqual([[]]);

    await membership.addPeer("r", "b", new Date(2));
    await membership.addPeer("r", "a", new Date(1));
    await nextMacrotask();
    expect(seen.at(-1)).toEqual(["a", "b"]);

    await membership.removePeer("r", "a");
    await nextMacrotask();
    expect(seen.at(-1)).toEqual(["b"]);
  });

  it("inbox: delivers each message once and never a deleted one", async () => {
    const inbox = new FakeSignalInbox(new FakeFirestoreState());
    const got: string[] = [];
    inbox.subscribeToMessages("r", "b", (m) => got.push(m.id));
    await inbox.addMessage("r", message("m1"));
    await nextMacrotask();
    await inbox.addMessage("r", message("m2"));
    await inbox.deleteMessage("r", "b", "m1");
    await nextMacrotask();
    expect(got).toEqual(["m1", "m2"]);
    expect(await inbox.messageExists("r", "b", "m1")).toBe(false);
  });

  it("election: claimHostIf only succeeds while the host document matches", async () => {
    const election = new FakeHostElection(new FakeFirestoreState());
    await election.writeHost("r", "a");
    expect(await election.claimHostIf("r", "x", "b")).toBe(false);
    expect(await election.claimHostIf("r", "a", "b")).toBe(true);
    expect((await election.getHost("r"))?.signalingPeerId).toBe("b");
  });

  it("election: candidates are scoped to one dead host", async () => {
    const election = new FakeHostElection(new FakeFirestoreState());
    await election.registerCandidate("r", "b", "dead1");
    await election.registerCandidate("r", "c", "dead2");
    expect(await election.listCandidates("r", "dead1")).toEqual(["b"]);
  });

  it("counts reads, writes and deletes", async () => {
    const state = new FakeFirestoreState();
    const membership = new FakeRoomMembership(state);
    await membership.addPeer("r", "a", new Date(0));
    await membership.peerExists("r", "a");
    await membership.removePeer("r", "a");
    expect(state.stats).toEqual({ reads: 1, writes: 1, deletes: 1 });
    state.resetStats();
    expect(state.stats).toEqual({ reads: 0, writes: 0, deletes: 0 });
  });

  it("a killed tab's subscriptions stop and its calls never finish", async () => {
    const state = new FakeFirestoreState();
    const life = new FakePortLife();
    const dying = new FakeRoomMembership(state, life);
    const seen = vi.fn();
    dying.subscribeToPeers("r", seen);
    await nextMacrotask();
    seen.mockClear();

    life.kill();
    await new FakeRoomMembership(state).addPeer("r", "a", new Date(0));
    await nextMacrotask();
    expect(seen).not.toHaveBeenCalled();

    let finished = false;
    void dying.addPeer("r", "z", new Date(0)).then(() => {
      finished = true;
    });
    await nextMacrotask();
    expect(finished).toBe(false);
  });
});
