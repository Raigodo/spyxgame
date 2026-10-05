// application/messaging/wire.ts
// Everything that crosses the network is parsed here, once.

import type { CommandResult, PeerId } from "./types";

export interface ChannelCopy {
  ch: string;
  epoch: number;
  rev: number;
  value: unknown;
  /** Per-sender high-water mark of applied command sequence numbers. */
  applied: Record<PeerId, number>;
}

export type Wire =
  | ({ __bus: 1; kind: "state" } & ChannelCopy)
  | { __bus: 1; kind: "offer"; channels: ChannelCopy[] }
  | { __bus: 1; kind: "sync"; ch: string }
  | {
      __bus: 1;
      kind: "command";
      ch: string;
      id: string;
      seq: number;
      type: string;
      payload: unknown;
    }
  | { __bus: 1; kind: "ack"; id: string; result: CommandResult }
  | { __bus: 1; kind: "event"; ch: string; event: unknown }
  | { __bus: 1; kind: "recover" };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function parseCopy(v: unknown): ChannelCopy | undefined {
  if (!isRec(v) || typeof v.ch !== "string" || !isInt(v.epoch) || !isInt(v.rev)) return undefined;
  if (!isRec(v.applied)) return undefined;
  const applied: Record<string, number> = {};
  for (const [k, n] of Object.entries(v.applied)) if (isInt(n)) applied[k] = n;
  return { ch: v.ch, epoch: v.epoch, rev: v.rev, value: v.value, applied };
}

function parseResult(v: unknown): CommandResult | undefined {
  if (!isRec(v)) return undefined;
  if (v.ok === true) return { ok: true };
  if (v.ok === false)
    return { ok: false, kind: "rejected", reason: String(v.reason ?? "rejected") };
  return undefined;
}

export function parseWire(v: unknown): Wire | undefined {
  if (!isRec(v) || v.__bus !== 1) return undefined;
  switch (v.kind) {
    case "state": {
      const copy = parseCopy(v);
      return copy && { __bus: 1, kind: "state", ...copy };
    }
    case "offer": {
      if (!Array.isArray(v.channels)) return undefined;
      const channels = v.channels.map(parseCopy).filter((c): c is ChannelCopy => !!c);
      return { __bus: 1, kind: "offer", channels };
    }
    case "sync":
      return typeof v.ch === "string" ? { __bus: 1, kind: "sync", ch: v.ch } : undefined;
    case "command":
      if (
        typeof v.ch !== "string" ||
        typeof v.id !== "string" ||
        typeof v.type !== "string" ||
        !isInt(v.seq)
      )
        return undefined;
      return {
        __bus: 1,
        kind: "command",
        ch: v.ch,
        id: v.id,
        seq: v.seq,
        type: v.type,
        payload: v.payload,
      };
    case "ack": {
      const result = parseResult(v.result);
      return typeof v.id === "string" && result
        ? { __bus: 1, kind: "ack", id: v.id, result }
        : undefined;
    }
    case "event":
      return typeof v.ch === "string"
        ? { __bus: 1, kind: "event", ch: v.ch, event: v.event }
        : undefined;
    case "recover":
      return { __bus: 1, kind: "recover" };
    default:
      return undefined;
  }
}
