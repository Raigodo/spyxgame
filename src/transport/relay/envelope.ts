import { s, type PeerId, type PlayerId } from "@/kernel";
import type { DropReason, Wire } from "../model";
import { FRAME } from "../names";

export type Envelope =
  | { kind: "hello"; playerId: PlayerId }
  | { kind: "bye"; reason: DropReason }
  | { kind: "app"; scope: "broadcast"; from: PeerId; msg: Wire }
  | { kind: "app"; scope: "direct"; from: PeerId; to: PeerId; msg: Wire };

export interface EnvelopeLimits {
  maxMessageChars: number;
}

interface AppShape {
  scope: "broadcast" | "direct";
  from: PeerId;
  to?: PeerId;
  msg: Wire;
}
type Parsed =
  | { kind: "hello"; playerId: PlayerId }
  | { kind: "bye"; reason: DropReason }
  | ({ kind: "app" } & AppShape);

/** Network input: the returned function turns a raw string into a well-formed Envelope or undefined. */
export function createEnvelopeParser(
  limits: EnvelopeLimits
): (raw: string) => Envelope | undefined {
  const schema = s.tagged("kind", {
    [FRAME.hello]: s.object({ playerId: s.id("player") }),
    [FRAME.bye]: s.object({ reason: s.oneOf(["kicked", "superseded"]) }),
    [FRAME.app]: s.object({
      scope: s.oneOf(["broadcast", "direct"]),
      from: s.id("peer"),
      to: s.optional(s.id("peer")),
      msg: s.json({ maxChars: limits.maxMessageChars }),
    }),
  });

  return (raw) => {
    if (raw.length > limits.maxMessageChars + 1_024) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = schema.parse(value) as unknown as Parsed | undefined;
    if (!parsed) return undefined;
    if (parsed.kind !== "app") return parsed;
    if (parsed.scope === "broadcast") {
      return { kind: "app", scope: "broadcast", from: parsed.from, msg: parsed.msg };
    }
    return parsed.to === undefined
      ? undefined
      : { kind: "app", scope: "direct", from: parsed.from, to: parsed.to, msg: parsed.msg };
  };
}

export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}
