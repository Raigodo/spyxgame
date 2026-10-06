// Built-in room feature: works the same in the lobby and in any game. Messages travel on a bus
// event channel (ephemeral, no replay). History lives here, so it survives page navigation
// inside the room. It does not survive a refresh, and late joiners don't see earlier messages.

import { Emitter, shortId, type ChatConfig, type Clock, type IdGenerator } from "@/shared/kernel";
import type { EventChannel, RoomBus } from "@/shared/application/messaging";
import { RateLimiter } from "./rate-limiter";

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
  bus: RoomBus;
  clock: Clock;
  ids: IdGenerator;
  config: ChatConfig;
  getLocalPeerId(): string | undefined;
  resolveSender(peerId: string): { playerId: string; nickname: string } | undefined;
  /** Sending is refused while the room is re-syncing (e.g. during a host change). */
  isReady(): boolean;
}

interface ChatPayload {
  text: string;
  direct: boolean;
}

export class ChatService {
  private readonly channel: EventChannel<ChatPayload>;
  private readonly unsubscribe: () => void;
  private readonly messageReceived = new Emitter<ChatLine>();
  // Replaced (never mutated) on each message, so the reference is stable between messages.
  private history: readonly ChatLine[] = [];
  private readonly sendLimiter: RateLimiter;
  private readonly receiveLimiter: RateLimiter;

  constructor(private readonly deps: ChatDeps) {
    const { bus, clock, config } = deps;
    const limiter = {
      clock,
      capacity: config.burst,
      refillPerSecond: config.refillPerSecond,
    };
    this.sendLimiter = new RateLimiter(limiter);
    this.receiveLimiter = new RateLimiter(limiter);

    this.channel = bus.eventChannel<ChatPayload>({
      id: "chat",
      validate: (raw) => this.parsePayload(raw),
    });
    this.unsubscribe = this.channel.onEvent((payload, from) => this.receive(payload, from));
  }

  getHistory(): readonly ChatLine[] {
    return this.history;
  }

  onMessage(handler: (line: ChatLine) => void): () => void {
    return this.messageReceived.on(handler);
  }

  /** Anything other than "sent" means nothing went out: empty or too long text, a message to yourself, room not ready, or rate-limited. */
  send(text: string, toPeerId?: string): ChatSendResult {
    const { ids, clock, config } = this.deps;
    const local = this.deps.getLocalPeerId();
    const clean = text.trim();
    if (!local || !clean || clean.length > config.maxTextLength || toPeerId === local) {
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
      id: ids.next(),
      fromPeerId: local,
      fromPlayerId: me?.playerId,
      fromName: me?.nickname ?? shortId(local),
      toPeerId,
      toName: target?.nickname ?? shortId(toPeerId),
      text: clean,
      direct: true,
      mine: true,
      at: clock.now(),
    });
    return "sent";
  }

  dispose(): void {
    this.unsubscribe();
    this.messageReceived.clear();
  }

  // Network input: never trust its shape.
  private parsePayload(v: unknown): ChatPayload | undefined {
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Record<string, unknown>;
    if (typeof r.text !== "string") return undefined;
    const text = r.text.trim();
    if (!text || text.length > this.deps.config.maxTextLength) return undefined;
    return { text, direct: r.direct === true };
  }

  private receive(payload: ChatPayload, from: string): void {
    // Our own messages were already limited on send. Everyone else's are checked here, because
    // a modified client can ignore its own limit.
    if (from !== this.deps.getLocalPeerId() && !this.receiveLimiter.tryTake(from)) return;

    const sender = this.deps.resolveSender(from);
    this.append({
      id: this.deps.ids.next(),
      fromPeerId: from,
      fromPlayerId: sender?.playerId,
      fromName: sender?.nickname ?? shortId(from),
      text: payload.text,
      direct: payload.direct,
      mine: from === this.deps.getLocalPeerId(),
      at: this.deps.clock.now(),
    });
  }

  private append(line: ChatLine): void {
    this.history = [...this.history, line].slice(-this.deps.config.maxHistory);
    this.messageReceived.emit(line);
  }
}
