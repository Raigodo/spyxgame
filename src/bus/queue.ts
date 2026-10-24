// Sender-side, in-memory. Holds commands until the host acks them, the TTL elapses, or the bus is
// disposed. Knows nothing about networking: the flow decides when to (re)send and records it with
// markSent(). Verdicts are strings here ("expired", "left", or the host's reason); the state
// channel narrows them to its own reason type.

import { fail, type Cancel, type ChannelId, type Clock, type PeerId, type Result } from "@/kernel";

export type Verdict = Result<void, string>;

export interface QueuedCommand {
  id: string;
  seq: number;
  ch: ChannelId;
  type: string;
  payload: unknown;
  /** Host this command was last sent to; cleared when the host changes. */
  sentTo?: PeerId;
}

interface Entry {
  cmd: QueuedCommand;
  resolve: (verdict: Verdict) => void;
  cancelTimer: Cancel;
}

export class CommandQueue {
  // Map preserves insertion order, which is sequence order.
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: { clock: Clock }) {}

  enqueue(cmd: QueuedCommand, ttlMs: number): Promise<Verdict> {
    return new Promise((resolve) => {
      const cancelTimer = this.deps.clock.after(ttlMs, () => this.settle(cmd.id, fail("expired")));
      this.entries.set(cmd.id, { cmd, resolve, cancelTimer });
    });
  }

  pending(): QueuedCommand[] {
    return Array.from(this.entries.values(), (e) => e.cmd);
  }

  markSent(id: string, to: PeerId): void {
    const entry = this.entries.get(id);
    if (entry) entry.cmd.sentTo = to;
  }

  /** Host changed: everything unacked must be sent again to the new host. */
  resetRouting(): void {
    for (const entry of this.entries.values()) entry.cmd.sentTo = undefined;
  }

  ack(id: string, verdict: Verdict): void {
    this.settle(id, verdict);
  }

  /** The bus was disposed first. */
  rejectAll(): void {
    for (const id of Array.from(this.entries.keys())) this.settle(id, fail("left"));
  }

  get size(): number {
    return this.entries.size;
  }

  private settle(id: string, verdict: Verdict): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.cancelTimer();
    this.entries.delete(id);
    entry.resolve(verdict);
  }
}
