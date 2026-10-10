import type { Clock } from "@/shared/kernel";
import type { FakeRtcPeerConnection } from "./fake-rtc-peer-connection";

/** All fake peer connections in one test, so an answer can find its offerer. */
export class FakeRtcNetwork {
  private readonly connections = new Map<string, FakeRtcPeerConnection>();
  private nextId = 0;

  constructor(private readonly clock: Clock) {}

  register(connection: FakeRtcPeerConnection): string {
    const id = `conn-${++this.nextId}`;
    this.connections.set(id, connection);
    return id;
  }

  get(id: string): FakeRtcPeerConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * A tab dies: its links go silent now, and the far ends notice after `detectionMs` (a browser
   * takes seconds to notice a dead peer; 0 means the next microtask).
   */
  kill(owner: string, detectionMs = 0): void {
    for (const connection of this.connections.values()) {
      if (connection.owner !== owner || connection.isClosed) continue;
      const remote = connection.remoteConnection;
      connection.drop();
      if (!remote || remote.owner === owner) continue;
      if (detectionMs <= 0) queueMicrotask(() => remote.lost());
      else this.clock.after(detectionMs, () => remote.lost());
    }
  }
}
