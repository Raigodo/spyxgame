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
  it("accepts an ICE candidate and keeps only known fields", () => {
    expect(
      parseRtcSignal({
        type: "ice-candidate",
        candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null, x: 1 },
      })
    ).toEqual({
      type: "ice-candidate",
      candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null },
    });
  });
  it("rejects bad candidate field types and non-objects", () => {
    expect(
      parseRtcSignal({ type: "ice-candidate", candidate: { sdpMLineIndex: 1.5 } })
    ).toBeUndefined();
    expect(parseRtcSignal({ type: "ice-candidate", candidate: { candidate: 5 } })).toBeUndefined();
    expect(parseRtcSignal({ type: "ice-candidate", candidate: [] })).toBeUndefined();
    expect(parseRtcSignal("offer")).toBeUndefined();
    expect(parseRtcSignal({ type: "nope" })).toBeUndefined();
    expect(
      parseRtcSignal({ type: "ice-candidate", candidate: { candidate: null } })
    ).toBeUndefined();
  });
});
