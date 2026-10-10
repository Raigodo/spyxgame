import type { Clock, Logger, WebRtcConfig } from "@/shared/kernel";
import type { SignalingPeerId, SignalingSession } from "../signaling";
import type { FormerHost } from "./types";

export interface HostReclaimControllerDeps {
  session: SignalingSession;
  clock: Clock;
  logger: Logger;
  config: WebRtcConfig;
}

// A refreshed host returns with a fresh peerId. While the host document still names its
// previous incarnation, take the seat back as soon as that peer is gone from the room. When
// pagehide already told us the old page is gone, remove it ourselves instead of waiting for
// the guests to notice. If the document names anyone else first, the window is over.
export class HostReclaimController {
  private active?: { former: SignalingPeerId; stop: () => void };

  constructor(private readonly deps: HostReclaimControllerDeps) {}

  /** The previous incarnation being reclaimed from, while a reclaim is running. */
  get former(): SignalingPeerId | undefined {
    return this.active?.former;
  }

  /** The host document changed: the window is over unless it still names the former peer. */
  onHostDocument(hostPeerId: SignalingPeerId | undefined): void {
    if (this.active && hostPeerId !== this.active.former) this.active.stop();
  }

  stop(): void {
    this.active?.stop();
  }

  start(former: FormerHost): void {
    const { session, clock, logger, config } = this.deps;
    this.active?.stop();
    const formerId = former.peerId;

    let done = false;
    let busy = false;
    let retry = false;

    const stop = () => {
      if (done) return;
      done = true;
      cancelTimer();
      offLeft();
      if (this.active?.former === formerId) this.active = undefined;
    };

    const attempt = async (final: boolean): Promise<void> => {
      if (done) return;
      if (busy) {
        retry = true;
        return;
      }
      busy = true;
      try {
        const result = await session.host.claimHost(formerId);
        logger.debug(`Host reclaim: ${result}`);
        if (result !== "former-present" || final) stop();
      } catch (error) {
        logger.warn("Host reclaim failed", error);
        stop();
      } finally {
        busy = false;
        if (retry && !done) {
          retry = false;
          void attempt(final);
        }
      }
    };

    const offLeft = session.onPeerLeft((peer) => {
      if (peer.peerId === formerId) void attempt(false);
    });
    const cancelTimer = clock.after(config.reclaimWindowMs, () => {
      void attempt(true);
    });
    this.active = { former: formerId, stop };

    if (former.confirmedGone) {
      void session
        .removePeer(formerId)
        .catch((error) => logger.warn("Failed to remove former host", error))
        .then(() => attempt(false));
    } else {
      void attempt(false);
    }
  }
}
