// Sender-side, in-memory. Holds commands until the host acks them, the TTL
// elapses, or the client leaves. Knows nothing about networking: the bus
// decides when to (re)send and records it with markSent().

import type { Cancel, Clock } from "@/shared/kernel";
import type { CommandResult, PeerId } from "./types";

export interface QueuedCommand {
  id: string;
  seq: number;
  ch: string;
  type: string;
  payload: unknown;
  /** Host this command was last sent to; cleared when the host changes. */
  sentTo?: PeerId;
}

interface Entry {
  cmd: QueuedCommand;
  resolve: (result: CommandResult) => void;
  cancelTimer: Cancel;
}

export class CommandQueue {
  // Map preserves insertion order, which is sequence order.
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly clock: Clock) {}

  enqueue(cmd: QueuedCommand, ttlMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      const cancelTimer = this.clock.after(ttlMs, () =>
        this.settle(cmd.id, { ok: false, kind: "expired", reason: "no ack before TTL" })
      );
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

  ack(id: string, result: CommandResult): void {
    this.settle(id, result);
  }

  rejectAll(reason: string): void {
    for (const id of Array.from(this.entries.keys())) {
      this.settle(id, { ok: false, kind: "left", reason });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private settle(id: string, result: CommandResult): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.cancelTimer();
    this.entries.delete(id);
    entry.resolve(result);
  }
}
