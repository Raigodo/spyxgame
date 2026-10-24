import { s } from "@/kernel";
import type { IceCandidate } from "./ports/rtc-peer-connection-port";

/** What travels inside a signaling message between two RTC layers. Signaling treats it as opaque. */
export type RtcSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-batch"; candidates: IceCandidate[] };

export interface SignalLimits {
  maxSdpChars: number;
  maxCandidateChars: number;
  maxIceCandidatesPerSignal: number;
}

/** Network input: the returned function gives a well-formed signal or undefined. */
export function createSignalParser(limits: SignalLimits): (raw: unknown) => RtcSignal | undefined {
  const description = s.object({ sdp: s.string({ max: limits.maxSdpChars }) });
  const candidate = s.object({
    candidate: s.optional(s.string({ max: limits.maxCandidateChars })),
    sdpMid: s.optional(s.nullable(s.string({ max: 256 }))),
    sdpMLineIndex: s.optional(s.nullable(s.int({ min: 0, max: 65_535 }))),
    usernameFragment: s.optional(s.nullable(s.string({ max: 256 }))),
  });
  const signal = s.tagged("type", {
    offer: description,
    answer: description,
    "ice-batch": s.object({
      candidates: s.list(candidate, {
        max: limits.maxIceCandidatesPerSignal,
        onInvalid: "reject",
      }),
    }),
  });

  return (raw) => {
    const parsed = signal.parse(raw) as unknown as RtcSignal | undefined;
    if (parsed?.type === "ice-batch" && parsed.candidates.length === 0) return undefined;
    return parsed;
  };
}
