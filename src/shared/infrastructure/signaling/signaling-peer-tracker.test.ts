import { expect, it, vi } from "vitest";
import { SignalingPeerTracker } from "./signaling-peer-tracker";

const peer = (peerId: string) => ({ peerId, joinedAt: new Date(0) });

it("a throwing handler does not stop the others, and is reported", () => {
  const errors: unknown[] = [];
  const tracker = new SignalingPeerTracker((e) => errors.push(e));
  const seen = vi.fn();
  tracker.onPeerAdded(() => {
    throw new Error("boom");
  });
  tracker.onPeerAdded(seen);
  tracker.add(peer("p"));
  expect(seen).toHaveBeenCalledOnce();
  expect(errors).toHaveLength(1);
});

it("rejects duplicate adds and unknown removes", () => {
  const tracker = new SignalingPeerTracker();
  tracker.add(peer("p"));
  expect(() => tracker.add(peer("p"))).toThrow();
  expect(() => tracker.remove("q")).toThrow();
});

it("clear fires removed for every peer, then empties", () => {
  const tracker = new SignalingPeerTracker();
  const removed = vi.fn();
  tracker.onPeerRemoved(removed);
  tracker.add(peer("a"));
  tracker.add(peer("b"));
  tracker.clear();
  expect(removed).toHaveBeenCalledTimes(2);
  expect(tracker.getAll()).toEqual([]);
});

it("unsubscribe stops delivery", () => {
  const tracker = new SignalingPeerTracker();
  const seen = vi.fn();
  const off = tracker.onPeerAdded(seen);
  off();
  tracker.add(peer("p"));
  expect(seen).not.toHaveBeenCalled();
});
