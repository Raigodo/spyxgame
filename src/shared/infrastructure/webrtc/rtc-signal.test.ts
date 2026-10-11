import { describe, expect, it } from "vitest";
import { parseRtcSignal } from "./rtc-signal";

describe("parseRtcSignal", () => {
  it("accepts offers and answers with a string sdp", () => {
    expect(parseRtcSignal({ type: "offer", sdp: "s", junk: 1 })).toEqual({
      type: "offer",
      sdp: "s",
    });
    expect(parseRtcSignal({ type: "answer", sdp: "s" })).toEqual({ type: "answer", sdp: "s" });
  });
  it("rejects a missing, non-string or oversized sdp", () => {
    expect(parseRtcSignal({ type: "offer" })).toBeUndefined();
    expect(parseRtcSignal({ type: "offer", sdp: 1 })).toBeUndefined();
    expect(parseRtcSignal({ type: "answer", sdp: "x".repeat(100_001) })).toBeUndefined();
  });
  it("accepts an ICE batch and keeps only known candidate fields", () => {
    expect(
      parseRtcSignal({
        type: "ice-batch",
        candidates: [
          { candidate: "c", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null, x: 1 },
        ],
      })
    ).toEqual({
      type: "ice-batch",
      candidates: [{ candidate: "c", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null }],
    });
  });
  it("rejects empty, oversized or malformed batches", () => {
    const ice = (candidates: unknown) => parseRtcSignal({ type: "ice-batch", candidates });
    expect(ice([])).toBeUndefined();
    expect(ice("x")).toBeUndefined();
    expect(ice(Array.from({ length: 51 }, () => ({ candidate: "c" })))).toBeUndefined();
    expect(ice([{ candidate: "c" }, { sdpMLineIndex: 1.5 }])).toBeUndefined();
    expect(ice([{ candidate: null }])).toBeUndefined();
    expect(ice([[]])).toBeUndefined();
    expect(parseRtcSignal({ type: "ice-candidate", candidate: {} })).toBeUndefined();
  });
});
