import { describe, expect, it } from "vitest";
import { createSignalParser } from "./rtc-signal";

const parse = createSignalParser({
  maxSdpChars: 20,
  maxCandidateChars: 20,
  maxIceCandidatesPerSignal: 2,
});

describe("createSignalParser", () => {
  it("accepts offer and answer, stripping extras", () => {
    expect(parse({ type: "offer", sdp: "v=0", extra: 1 })).toEqual({ type: "offer", sdp: "v=0" });
    expect(parse({ type: "answer", sdp: "v=0" })).toEqual({ type: "answer", sdp: "v=0" });
  });
  it("rejects an oversize sdp, a missing sdp and an unknown type", () => {
    expect(parse({ type: "offer", sdp: "x".repeat(21) })).toBeUndefined();
    expect(parse({ type: "offer" })).toBeUndefined();
    expect(parse({ type: "nope", sdp: "v" })).toBeUndefined();
    expect(parse("offer")).toBeUndefined();
  });
  it("accepts an ice batch and keeps optional candidate fields", () => {
    const out = parse({
      type: "ice-batch",
      candidates: [{ candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 }, { candidate: "c2" }],
    });
    expect(out).toEqual({
      type: "ice-batch",
      candidates: [{ candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 }, { candidate: "c2" }],
    });
  });
  it("rejects an empty batch, too many candidates and any invalid candidate", () => {
    expect(parse({ type: "ice-batch", candidates: [] })).toBeUndefined();
    expect(
      parse({
        type: "ice-batch",
        candidates: [{ candidate: "a" }, { candidate: "b" }, { candidate: "c" }],
      })
    ).toBeUndefined();
    expect(
      parse({ type: "ice-batch", candidates: [{ candidate: "x".repeat(21) }] })
    ).toBeUndefined();
    expect(parse({ type: "ice-batch", candidates: [{ sdpMLineIndex: -1 }] })).toBeUndefined();
  });
});
