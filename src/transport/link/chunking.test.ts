import { describe, expect, it } from "vitest";
import { as, type PeerId } from "@/kernel";
import { ChunkReassembler, classifyIncoming, splitMessage } from "./chunking";

const from = as<PeerId>("p");
const frame = (o: Record<string, unknown>) => JSON.stringify({ __chunk: true, ...o });

describe("splitMessage", () => {
  it("returns a short message untouched", () => {
    expect(splitMessage("abc", 10, "m")).toEqual(["abc"]);
    expect(splitMessage("abcd", 4, "m")).toEqual(["abcd"]);
  });
  it("splits into ordered frames that rejoin to the original", () => {
    const frames = splitMessage("abcdefghij", 4, "m1");
    expect(frames).toHaveLength(3);
    const parsed = frames.map(
      (f) => JSON.parse(f) as { index: number; total: number; data: string; messageId: string }
    );
    expect(parsed.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(parsed.every((p) => p.total === 3 && p.messageId === "m1")).toBe(true);
    expect(parsed.map((p) => p.data).join("")).toBe("abcdefghij");
  });
});

describe("classifyIncoming", () => {
  it("non-JSON and non-chunk JSON are plain", () => {
    for (const raw of ["hello", "123", "null", '{"a":1}', '{"__chunk":false}']) {
      expect(classifyIncoming(raw, 10)).toEqual({ kind: "plain" });
    }
  });
  it("a well-formed chunk is classified with its envelope", () => {
    const raw = frame({ messageId: "m", index: 1, total: 2, data: "x" });
    expect(classifyIncoming(raw, 10)).toEqual({
      kind: "chunk",
      envelope: { messageId: "m", index: 1, total: 2, data: "x" },
    });
  });
  it("malformed or out-of-bounds chunks are invalid", () => {
    const bad = [
      { messageId: "m", index: 2, total: 2, data: "x" }, // index == total
      { messageId: "m", index: -1, total: 2, data: "x" },
      { messageId: "m", index: 0, total: 0, data: "x" },
      { messageId: "m", index: 0, total: 11, data: "x" }, // over maxChunks
      { messageId: "m", index: 0.5, total: 2, data: "x" },
      { index: 0, total: 2, data: "x" }, // no messageId
      { messageId: "m", index: 0, total: 2 }, // no data
    ];
    for (const b of bad) expect(classifyIncoming(frame(b), 10)).toEqual({ kind: "invalid" });
  });
});

describe("ChunkReassembler", () => {
  const env = (index: number, total: number, data: string, messageId = "m") => ({
    messageId,
    index,
    total,
    data,
  });

  it("reassembles out-of-order chunks", () => {
    const r = new ChunkReassembler(1_000);
    expect(r.accept(from, env(2, 3, "c"), 0)).toBeUndefined();
    expect(r.accept(from, env(0, 3, "a"), 0)).toBeUndefined();
    expect(r.accept(from, env(1, 3, "b"), 0)).toBe("abc");
  });
  it("a duplicate chunk is not counted twice", () => {
    const r = new ChunkReassembler(1_000);
    r.accept(from, env(0, 2, "a"), 0);
    expect(r.accept(from, env(0, 2, "a"), 0)).toBeUndefined();
    expect(r.accept(from, env(1, 2, "b"), 0)).toBe("ab");
  });
  it("keeps senders and message ids apart", () => {
    const r = new ChunkReassembler(1_000);
    r.accept(from, env(0, 2, "a", "m1"), 0);
    r.accept(as<PeerId>("q"), env(0, 2, "X", "m1"), 0);
    expect(r.accept(from, env(1, 2, "b", "m1"), 0)).toBe("ab");
  });
  it("an inconsistent total discards the whole message", () => {
    const r = new ChunkReassembler(1_000);
    r.accept(from, env(0, 2, "a"), 0);
    expect(r.accept(from, env(1, 3, "b"), 0)).toBeUndefined();
    // buffer was dropped: the second chunk of the original starts a fresh buffer
    expect(r.accept(from, env(1, 2, "b"), 0)).toBeUndefined();
  });
  it("dropExpired discards stale partial messages; clear discards all", () => {
    const r = new ChunkReassembler(1_000);
    r.accept(from, env(0, 2, "a"), 0);
    r.dropExpired(1_000);
    expect(r.accept(from, env(1, 2, "b"), 1_000)).toBeUndefined();
    r.clear();
    expect(r.accept(from, env(0, 2, "a"), 1_000)).toBeUndefined();
  });
});
