import type { SignalingPeerId } from "../signaling";

export interface ChunkEnvelope {
  __chunk: true;
  messageId: string;
  index: number;
  total: number;
  data: string;
}

export type IncomingKind =
  | { kind: "plain" }
  | { kind: "chunk"; envelope: ChunkEnvelope }
  /** Claims to be a chunk but is malformed or out of bounds. Dropped. */
  | { kind: "invalid" };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Splits into envelopes of at most `maxChunkSize` characters (UTF-16 units, not bytes). */
export function splitMessage(message: string, maxChunkSize: number, messageId: string): string[] {
  if (message.length <= maxChunkSize) return [message];

  const total = Math.ceil(message.length / maxChunkSize);
  const chunks: string[] = [];
  for (let index = 0; index < total; index++) {
    const envelope: ChunkEnvelope = {
      __chunk: true,
      messageId,
      index,
      total,
      data: message.slice(index * maxChunkSize, (index + 1) * maxChunkSize),
    };
    chunks.push(JSON.stringify(envelope));
  }
  return chunks;
}

/** Network input: classifies a raw string and validates a chunk envelope's shape and bounds. */
export function classifyIncoming(raw: string, maxChunks: number): IncomingKind {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "plain" }; // not JSON at all: a complete message
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "plain" };

  const r = parsed as Record<string, unknown>;
  if (r.__chunk !== true) return { kind: "plain" };

  if (
    typeof r.messageId !== "string" ||
    typeof r.data !== "string" ||
    !isInt(r.total) ||
    !isInt(r.index) ||
    r.total < 1 ||
    r.total > maxChunks ||
    r.index < 0 ||
    r.index >= r.total
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "chunk",
    envelope: {
      __chunk: true,
      messageId: r.messageId,
      index: r.index,
      total: r.total,
      data: r.data,
    },
  };
}

interface Buffer {
  parts: Array<string | undefined>;
  received: number;
  total: number;
  expiresAt: number;
}

/** Reassembles chunks per (sender, messageId). Time is passed in, so it needs no clock. */
export class ChunkReassembler {
  private readonly buffers = new Map<string, Buffer>();

  constructor(private readonly ttlMs: number) {}

  /** Returns the full message when its last chunk arrives, otherwise undefined. */
  accept(from: SignalingPeerId, chunk: ChunkEnvelope, now: number): string | undefined {
    const key = `${from}:${chunk.messageId}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = {
        parts: new Array<string | undefined>(chunk.total).fill(undefined),
        received: 0,
        total: chunk.total,
        expiresAt: now + this.ttlMs,
      };
      this.buffers.set(key, buffer);
    } else if (buffer.total !== chunk.total) {
      this.buffers.delete(key); // inconsistent sender: discard the whole message
      return undefined;
    }

    if (buffer.parts[chunk.index] === undefined) {
      buffer.parts[chunk.index] = chunk.data;
      buffer.received++;
    }
    if (buffer.received < buffer.total) return undefined;

    this.buffers.delete(key);
    return buffer.parts.join("");
  }

  dropExpired(now: number): void {
    for (const [key, buffer] of this.buffers) {
      if (buffer.expiresAt <= now) this.buffers.delete(key);
    }
  }

  clear(): void {
    this.buffers.clear();
  }
}
