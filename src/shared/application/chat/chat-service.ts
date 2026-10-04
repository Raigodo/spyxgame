// application/chat/chat-service.ts
// Built-in room feature: works the same in the lobby and in any game. Messages
// travel on a bus event channel (ephemeral, no replay). History lives here, so
// it survives page navigation inside the room. It does not survive a refresh,
// and late joiners don't see earlier messages.

import type { EventChannel, RoomBus } from "@/shared/application/messaging";
import { RateLimiter } from "./rate-limiter";

/** Generous on purpose: a burst of 10, then 1 message per second sustained. */
export const CHAT_BURST = 30;
export const CHAT_REFILL_PER_SECOND = 1;

export const MAX_CHAT_TEXT_LENGTH = 500;
export const MAX_CHAT_HISTORY = 200;

export type ChatSendResult = "sent" | "invalid" | "not-ready" | "rate-limited";

export interface ChatLine {
  /** Generated locally on receipt, so a sender can't forge keys. */
  id: string;
  fromPeerId: string;
  /** Resolved from the roster when the message arrived. */
  fromPlayerId?: string;
  fromName: string;
  /** Set on direct messages you sent. */
  toPeerId?: string;
  toName?: string;
  text: string;
  direct: boolean;
  mine: boolean;
  at: number;
}

export interface ChatDeps {
  getLocalPeerId(): string | undefined;
  resolveSender(peerId: string): { playerId: string; nickname: string } | undefined;
  /** Sending is refused while the room is re-syncing (e.g. during a host change). */
  isReady(): boolean;
}

interface ChatPayload {
  text: string;
  direct: boolean;
}

// Network input: never trust its shape.
function parsePayload(v: unknown): ChatPayload | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.text !== "string") return undefined;
  const text = r.text.trim();
  if (!text || text.length > MAX_CHAT_TEXT_LENGTH) return undefined;
  return { text, direct: r.direct === true };
}

const short = (id: string) => id.slice(0, 8);

export class ChatService {
  private readonly channel: EventChannel<ChatPayload>;
  private readonly unsubscribe: () => void;
  private readonly handlers = new Set<(line: ChatLine) => void>();
  // Replaced (never mutated) on each message, so the reference is stable between messages.
  private history: readonly ChatLine[] = [];
  private readonly sendLimiter = new RateLimiter(CHAT_BURST, CHAT_REFILL_PER_SECOND);
  private readonly receiveLimiter = new RateLimiter(CHAT_BURST, CHAT_REFILL_PER_SECOND);

  constructor(
    bus: RoomBus,
    private readonly deps: ChatDeps
  ) {
    this.channel = bus.eventChannel<ChatPayload>({ id: "chat", validate: parsePayload });
    this.unsubscribe = this.channel.onEvent((payload, from) => this.receive(payload, from));
  }

  getHistory(): readonly ChatLine[] {
    return this.history;
  }

  onMessage(handler: (line: ChatLine) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Returns false (nothing sent) if the text is empty or too long, the target is yourself, or the room is not ready. */
  send(text: string, toPeerId?: string): ChatSendResult {
    const local = this.deps.getLocalPeerId();
    const clean = text.trim();
    if (!local || !clean || clean.length > MAX_CHAT_TEXT_LENGTH || toPeerId === local) {
      return "invalid";
    }
    if (!this.deps.isReady()) return "not-ready";
    if (!this.sendLimiter.tryTake(local)) return "rate-limited"; // only counts messages that would really go out

    if (toPeerId === undefined) {
      // The channel delivers broadcasts to the sender locally; receive() adds our own line.
      this.channel.broadcast({ text: clean, direct: false });
      return "sent";
    }

    this.channel.sendTo(toPeerId, { text: clean, direct: true });
    const me = this.deps.resolveSender(local);
    const target = this.deps.resolveSender(toPeerId);
    this.append({
      id: crypto.randomUUID(),
      fromPeerId: local,
      fromPlayerId: me?.playerId,
      fromName: me?.nickname ?? short(local),
      toPeerId,
      toName: target?.nickname ?? short(toPeerId),
      text: clean,
      direct: true,
      mine: true,
      at: Date.now(),
    });
    return "sent";
  }

  dispose(): void {
    this.unsubscribe();
    this.handlers.clear();
  }

  private receive(payload: ChatPayload, from: string): void {
    // Our own messages were already limited on send. Everyone else's are checked here,
    // because a modified client can ignore its own limit.
    if (from !== this.deps.getLocalPeerId() && !this.receiveLimiter.tryTake(from)) return;

    const sender = this.deps.resolveSender(from);
    this.append({
      id: crypto.randomUUID(),
      fromPeerId: from,
      fromPlayerId: sender?.playerId,
      fromName: sender?.nickname ?? short(from),
      text: payload.text,
      direct: payload.direct,
      mine: from === this.deps.getLocalPeerId(),
      at: Date.now(),
    });
  }

  private append(line: ChatLine): void {
    this.history = [...this.history, line].slice(-MAX_CHAT_HISTORY);
    for (const handler of Array.from(this.handlers)) handler(line);
  }
}
