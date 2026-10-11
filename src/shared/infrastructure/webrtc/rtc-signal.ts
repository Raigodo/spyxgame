import { isRecord } from "@/shared/kernel";
import type { IceCandidate } from "./ports/rtc-peer-connection-port";

/** What travels inside a signaling message between two RTC layers. Signaling treats it as opaque. */
export type RtcSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-batch"; candidates: IceCandidate[] };

const MAX_SDP = 100_000;
const MAX_CANDIDATE = 4_000;
const MAX_BATCH = 50;

const optString = (v: unknown): string | null | undefined | "bad" =>
  v === undefined || v === null || typeof v === "string" ? v : "bad";
const optInt = (v: unknown): number | null | undefined | "bad" =>
  v === undefined || v === null || (typeof v === "number" && Number.isInteger(v)) ? v : "bad";

function parseCandidate(c: unknown): IceCandidate | undefined {
  if (!isRecord(c)) return undefined;
  if (c.candidate !== undefined && typeof c.candidate !== "string") return undefined;
  if (typeof c.candidate === "string" && c.candidate.length > MAX_CANDIDATE) return undefined;
  const fields = {
    candidate: c.candidate,
    sdpMid: optString(c.sdpMid),
    sdpMLineIndex: optInt(c.sdpMLineIndex),
    usernameFragment: optString(c.usernameFragment),
  };
  if (Object.values(fields).includes("bad")) return undefined;
  return fields as IceCandidate; // safe: each field was checked above
}

/** Network input: a well-formed signal or undefined. */
export function parseRtcSignal(raw: unknown): RtcSignal | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "offer" || raw.type === "answer") {
    return typeof raw.sdp === "string" && raw.sdp.length <= MAX_SDP
      ? { type: raw.type, sdp: raw.sdp }
      : undefined;
  }
  if (raw.type === "ice-batch") {
    const list = raw.candidates;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) return undefined;
    const candidates = list.map(parseCandidate);
    if (candidates.some((c) => c === undefined)) return undefined;
    return { type: "ice-batch", candidates: candidates as IceCandidate[] };
  }
  return undefined;
}
