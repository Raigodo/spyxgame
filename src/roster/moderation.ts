// Host-only moderation: kick, ban, unban, hand the host role over. Thin: the decisions are the
// reducers' (rules.ts) and the transport's. This class only resolves ids to peers and sequences
// "change the roster, then close the peer".

import { fail, ok, type PlayerId, type Result } from "@/kernel";
import type { Bus } from "@/bus";
import type { HandOffReject, Transport } from "@/transport";
import type { Logger } from "@/kernel";
import type { RosterCommand, TargetReject } from "./model";
import type { RosterStateHandle } from "./state";

export interface ModerationDeps {
  transport: Pick<Transport, "role" | "drop" | "handOff">;
  bus: Pick<Bus, "sync">;
  state: RosterStateHandle;
  localPlayerId: PlayerId;
  log: Logger;
}

/** Pure: a reducer or bus reason as the public TargetReject. */
export function toTargetReject(reason: string): TargetReject {
  switch (reason) {
    case "unknown-player":
    case "cannot-target-self":
    case "not-ready":
      return reason;
    case "host-only":
      return "not-host";
    default:
      return "unknown-player";
  }
}

export class Moderation {
  private readonly deps: ModerationDeps;

  constructor(deps: ModerationDeps) {
    this.deps = deps;
  }

  /** Removes the row and closes the target's link. */
  async kick(id: PlayerId): Promise<Result<void, TargetReject>> {
    return this.removeAndDrop(id, { type: "remove", playerId: id });
  }

  /** Like kick, and the player cannot join again until unbanned. */
  async ban(id: PlayerId): Promise<Result<void, TargetReject>> {
    return this.removeAndDrop(id, { type: "ban", playerId: id });
  }

  async unban(id: PlayerId): Promise<Result<void, TargetReject>> {
    const gate = this.gate();
    if (gate) return fail(gate);
    return this.run({ type: "unban", playerId: id });
  }

  async handOff(id: PlayerId): Promise<Result<void, TargetReject | HandOffReject>> {
    const gate = this.gate();
    if (gate) return fail(gate);
    if (id === this.deps.localPlayerId) return fail("cannot-target-self");
    const peer = this.livePeerOf(id);
    if (!peer) return fail("unknown-player");
    return this.deps.transport.handOff(peer);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private gate(): "not-host" | "not-ready" | undefined {
    if (this.deps.transport.role.get() !== "host") return "not-host";
    if (this.deps.bus.sync.get() !== "ready") return "not-ready";
    return undefined;
  }

  private livePeerOf(id: PlayerId) {
    return this.deps.state.value.get()?.entries[id]?.peerId;
  }

  private run(cmd: RosterCommand): Result<void, TargetReject> {
    const result = this.deps.state.apply(cmd);
    return result.ok ? ok(undefined) : fail(toTargetReject(result.reason));
  }

  private async removeAndDrop(
    id: PlayerId,
    cmd: RosterCommand
  ): Promise<Result<void, TargetReject>> {
    const gate = this.gate();
    if (gate) return fail(gate);
    const peer = this.livePeerOf(id); // read before the entry is gone
    const result = this.run(cmd);
    if (!result.ok) return result;
    if (peer) {
      await this.deps.transport.drop(peer, "kicked").catch((error: unknown) => {
        this.deps.log.warn("Dropping a removed player failed", { id, error });
      });
    }
    return ok(undefined);
  }
}
