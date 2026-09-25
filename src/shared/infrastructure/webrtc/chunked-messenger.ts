import { SignalingPeerId } from "../signaling";
import type { WebRtcService } from "./web-rtc-service";

// Conservative: comfortably under the ~16KB-ish limit that's reliable
// across browsers for a single RTCDataChannel send().
const MAX_CHUNK_SIZE = 12_000;
const CHUNK_BUFFER_TTL_MS = 30_000;

interface ChunkEnvelope {
  __chunk: true;
  messageId: string;
  index: number;
  total: number;
  data: string;
}

type MessageHandler = (message: string, from: SignalingPeerId) => void;

// Makes "send a string of any size, reliably" possible over WebRtcService's
// raw messaging by splitting into bounded chunks and reassembling on the
// other end. WebRtcService's data channels are already ordered+reliable by
// default, so chunks of one message never arrive out of order relative to
// each other; buffers are still keyed by (sender, messageId) so concurrent
// large messages from different senders never collide.
export class ChunkedMessenger {
  private readonly buffers = new Map<
    string,
    { parts: string[]; received: number; total: number; expiresAt: number }
  >();
  private readonly messageHandlers = new Set<MessageHandler>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly rtc: WebRtcService) {
    rtc.onMessage((raw, from) => this.handleIncoming(raw, from));
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.dropExpiredBuffers(), CHUNK_BUFFER_TTL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.buffers.clear();
  }

  sendToPeer(peerId: SignalingPeerId, message: string): void {
    for (const chunk of this.split(message)) {
      this.rtc.sendMessageToPeer(peerId, chunk);
    }
  }

  broadcast(message: string): void {
    for (const chunk of this.split(message)) {
      this.rtc.broadcastMessage(chunk);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  private split(message: string): string[] {
    if (message.length <= MAX_CHUNK_SIZE) {
      return [message];
    }

    const messageId = crypto.randomUUID();
    const total = Math.ceil(message.length / MAX_CHUNK_SIZE);
    const chunks: string[] = [];
    for (let index = 0; index < total; index++) {
      const data = message.slice(index * MAX_CHUNK_SIZE, (index + 1) * MAX_CHUNK_SIZE);
      const envelope: ChunkEnvelope = {
        __chunk: true,
        messageId,
        index,
        total,
        data,
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
      this.emit(raw, from); // not JSON at all — pass through as complete
      return;
    }

    if (!this.isChunkEnvelope(parsed)) {
      this.emit(raw, from); // ordinary, already-complete message
      return;
    }

    const key = `${from}:${parsed.messageId}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = {
        parts: new Array(parsed.total),
        received: 0,
        total: parsed.total,
        expiresAt: Date.now() + CHUNK_BUFFER_TTL_MS,
      };
      this.buffers.set(key, buffer);
    }

    if (buffer.parts[parsed.index] === undefined) {
      buffer.parts[parsed.index] = parsed.data;
      buffer.received++;
    }

    if (buffer.received === buffer.total) {
      this.buffers.delete(key);
      this.emit(buffer.parts.join(""), from);
    }
  }

  private isChunkEnvelope(value: unknown): value is ChunkEnvelope {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).__chunk === true &&
      typeof (value as Record<string, unknown>).messageId === "string"
    );
  }

  private emit(message: string, from: SignalingPeerId): void {
    for (const handler of this.messageHandlers) handler(message, from);
  }

  private dropExpiredBuffers(): void {
    const now = Date.now();
    for (const [key, buffer] of this.buffers) {
      if (buffer.expiresAt <= now) this.buffers.delete(key);
    }
  }
}
