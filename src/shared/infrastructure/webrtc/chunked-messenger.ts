import {
  Emitter,
  type Cancel,
  type Clock,
  type IdGenerator,
  type WebRtcConfig,
} from "@/shared/kernel";
import type { SignalingPeerId } from "../signaling";
import type { WebRtcService } from "./web-rtc-service";

interface ChunkEnvelope {
  __chunk: true;
  messageId: string;
  index: number;
  total: number;
  data: string;
}

/** The part of WebRtcService the messenger needs. A test fake only implements these. */
export type RawMessaging = Pick<
  WebRtcService,
  "onMessage" | "sendMessageToPeer" | "broadcastMessage"
>;

export interface ChunkedMessengerDeps {
  rtc: RawMessaging;
  clock: Clock;
  ids: IdGenerator;
  config: WebRtcConfig;
}

type MessageHandler = (message: string, from: SignalingPeerId) => void;

// Makes "send a string of any size, reliably" possible over WebRtcService's raw messaging by
// splitting into bounded chunks and reassembling on the other end. Data channels are ordered and
// reliable per connection, so chunks of one message never arrive out of order relative to each
// other; buffers are still keyed by (sender, messageId) so concurrent large messages from
// different senders never collide.
export class ChunkedMessenger {
  private readonly buffers = new Map<
    string,
    { parts: string[]; received: number; total: number; expiresAt: number }
  >();
  private readonly messageReceived = new Emitter<{ message: string; from: SignalingPeerId }>();
  private cancelCleanup?: Cancel;

  constructor(private readonly deps: ChunkedMessengerDeps) {
    deps.rtc.onMessage((raw, from) => this.handleIncoming(raw, from));
  }

  start(): void {
    this.cancelCleanup?.();
    this.cancelCleanup = this.deps.clock.every(this.deps.config.chunkBufferTtlMs, () =>
      this.dropExpiredBuffers()
    );
  }

  stop(): void {
    this.cancelCleanup?.();
    this.cancelCleanup = undefined;
    this.buffers.clear();
  }

  sendToPeer(peerId: SignalingPeerId, message: string): void {
    for (const chunk of this.split(message)) this.deps.rtc.sendMessageToPeer(peerId, chunk);
  }

  broadcast(message: string): void {
    for (const chunk of this.split(message)) this.deps.rtc.broadcastMessage(chunk);
  }

  onMessage(handler: MessageHandler): () => void {
    return this.messageReceived.on(({ message, from }) => handler(message, from));
  }

  private split(message: string): string[] {
    const size = this.deps.config.maxChunkSize;
    if (message.length <= size) return [message];

    const messageId = this.deps.ids.next();
    const total = Math.ceil(message.length / size);
    const chunks: string[] = [];
    for (let index = 0; index < total; index++) {
      const envelope: ChunkEnvelope = {
        __chunk: true,
        messageId,
        index,
        total,
        data: message.slice(index * size, (index + 1) * size),
      };
      chunks.push(JSON.stringify(envelope));
    }
    return chunks;
  }

  private handleIncoming(raw: string, from: SignalingPeerId): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.messageReceived.emit({ message: raw, from }); // not JSON at all: pass through as complete
      return;
    }

    if (!isChunkEnvelope(parsed)) {
      this.messageReceived.emit({ message: raw, from }); // ordinary, already-complete message
      return;
    }

    const key = `${from}:${parsed.messageId}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = {
        parts: new Array<string>(parsed.total),
        received: 0,
        total: parsed.total,
        expiresAt: this.deps.clock.now() + this.deps.config.chunkBufferTtlMs,
      };
      this.buffers.set(key, buffer);
    }

    if (buffer.parts[parsed.index] === undefined) {
      buffer.parts[parsed.index] = parsed.data;
      buffer.received++;
    }

    if (buffer.received === buffer.total) {
      this.buffers.delete(key);
      this.messageReceived.emit({ message: buffer.parts.join(""), from });
    }
  }

  private dropExpiredBuffers(): void {
    const now = this.deps.clock.now();
    for (const [key, buffer] of this.buffers) {
      if (buffer.expiresAt <= now) this.buffers.delete(key);
    }
  }
}

function isChunkEnvelope(value: unknown): value is ChunkEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__chunk === true &&
    typeof (value as Record<string, unknown>).messageId === "string"
  );
}
