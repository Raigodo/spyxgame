import type { Clock, Logger, WebRtcConfig } from "@/shared/kernel";

export const PROBE_PING = '{"__probe":"ping"}';
export const PROBE_PONG = '{"__probe":"pong"}';

/** Control messages are exact strings, so they never need parsing (and never reach the app). */
export function classifyProbe(raw: string): "ping" | "pong" | undefined {
  return raw === PROBE_PING ? "ping" : raw === PROBE_PONG ? "pong" : undefined;
}

export type ProbeAction = "none" | "ping" | "dead";

export function decideProbe(a: {
  now: number;
  lastInbound: number;
  pingSentAt?: number;
  idleMs: number;
  timeoutMs: number;
}): ProbeAction {
  // A ping is outstanding (nothing arrived since): wait for the answer, then give up.
  if (a.pingSentAt !== undefined && a.lastInbound < a.pingSentAt) {
    return a.now - a.pingSentAt >= a.timeoutMs ? "dead" : "none";
  }
  return a.now - a.lastInbound >= a.idleMs ? "ping" : "none";
}

export interface LinkProbeDeps {
  clock: Clock;
  config: WebRtcConfig;
  logger: Logger;
  /** Only the host probes. */
  isActive(): boolean;
  send(text: string): void;
  onDead(): void;
}

// Watches one open data channel for silence. Any inbound message counts as proof of life.
export class LinkProbe {
  private lastInbound: number;
  private pingSentAt?: number;
  private readonly cancel: () => void;

  constructor(private readonly deps: LinkProbeDeps) {
    this.lastInbound = deps.clock.now();
    const { probeIdleMs, probeTimeoutMs } = deps.config;
    this.cancel = deps.clock.every(Math.min(probeIdleMs, probeTimeoutMs) / 2, () => this.tick());
  }

  noteInbound(): void {
    this.lastInbound = this.deps.clock.now();
  }

  stop(): void {
    this.cancel();
  }

  private tick(): void {
    if (!this.deps.isActive()) return;
    const { clock, config } = this.deps;
    const action = decideProbe({
      now: clock.now(),
      lastInbound: this.lastInbound,
      pingSentAt: this.pingSentAt,
      idleMs: config.probeIdleMs,
      timeoutMs: config.probeTimeoutMs,
    });
    if (action === "ping") {
      this.pingSentAt = clock.now();
      this.deps.send(PROBE_PING);
    } else if (action === "dead") {
      this.stop();
      this.deps.onDead();
    }
  }
}
