import { type KeyValueStore, Scope, type PeerId, type PlayerId, type RoomId } from "@/kernel";
import {
  FakeClock,
  FakeIds,
  FakePageLifecycle,
  MemoryKeyValueStore,
  nextMacrotask,
  RecordingLogger,
} from "@/kernel/fakes";
import { linkConfig, signalingConfig } from "./config";
import { FakeRtcConnectionProvider, FakeRtcNetwork } from "./link/fakes";
import { joinTransport } from "./flow";
import type { IceServerSource, TransportDeps } from "./index";
import type { Transport } from "./model";
import {
  FakeFirestoreState,
  FakeHostElection,
  FakePortLife,
  FakeRoomMembership,
  FakeSignalInbox,
} from "./signaling/fakes";
import { ScopedClock } from "@/kernel/scoped-clock";

export * from "./signaling/fakes";
export * from "./link/fakes";

export class FakeIceServerSource implements IceServerSource {
  async fetch() {
    return [];
  }
}

export interface HarnessPeer {
  readonly name: string;
  readonly playerId: PlayerId;
  readonly tabStore: KeyValueStore;
  readonly pageLifecycle: FakePageLifecycle;
  readonly scope: Scope;
  transport?: Transport;
  /** Abrupt death: no leave, no pagehide. Far ends notice after `detectionMs`. */
  kill(detectionMs?: number): void;
  /** Link stays open, nothing flows. */
  silence(): void;
}

/**
 * N real transports over one fake Firestore, one fake RTC network and one fake clock.
 * Waits with real setImmediate: never combine with vi.useFakeTimers().
 */
export class TransportHarness {
  readonly clock = new FakeClock();
  readonly ids = new FakeIds();
  readonly logger = new RecordingLogger();
  readonly firestore = new FakeFirestoreState();
  readonly rtc = new FakeRtcNetwork(this.clock);
  private nextPlayer = 0;

  addPeer(
    name: string,
    options: { playerId?: PlayerId; tabStore?: KeyValueStore } = {}
  ): HarnessPeer {
    const clock = new ScopedClock(this.clock);
    const life = new FakePortLife();
    const tabStore = options.tabStore ?? new MemoryKeyValueStore();
    const pageLifecycle = new FakePageLifecycle();
    const scope = new Scope({ onError: (e) => this.logger.error("Cleanup failed", e) });
    const playerId = options.playerId ?? (`player-${name}-${++this.nextPlayer}` as PlayerId);

    const deps: TransportDeps = {
      clock,
      ids: this.ids,
      log: this.logger.child(name),
      storages: { tab: tabStore },
      pageLifecycle,
      membership: new FakeRoomMembership(this.firestore, life),
      inbox: new FakeSignalInbox(this.firestore, life),
      election: new FakeHostElection(this.firestore, life),
      connections: new FakeRtcConnectionProvider(this.rtc, name),
      iceServers: new FakeIceServerSource(),
      config: { signaling: signalingConfig.defaults, link: linkConfig.defaults },
    };

    const peer: HarnessPeer = {
      name,
      playerId,
      tabStore,
      pageLifecycle,
      scope,
      kill: (detectionMs) => {
        clock.kill();
        life.kill();
        this.rtc.kill(name, detectionMs);
      },
      silence: () => this.rtc.silence(name),
    };
    (peer as { deps?: TransportDeps }).deps = deps;
    return peer;
  }

  async join(peer: HarnessPeer, roomId: string): Promise<Transport> {
    const deps = (peer as unknown as { deps: TransportDeps }).deps;
    const result = await joinTransport(
      deps,
      { roomId: roomId as RoomId, playerId: peer.playerId },
      peer.scope
    );
    if (!result.ok)
      throw new Error(`[harness] ${peer.name} failed to join: ${String(result.reason)}`);
    peer.transport = result.value;
    await this.settle();
    return result.value;
  }

  /** A page refresh: pagehide, the old tab dies, a new peer rejoins with the same playerId and tab store. */
  async refresh(peer: HarnessPeer, roomId: string): Promise<HarnessPeer> {
    peer.pageLifecycle.hide();
    peer.kill();
    const next = this.addPeer(`${peer.name}'`, {
      playerId: peer.playerId,
      tabStore: peer.tabStore,
    });
    await this.join(next, roomId);
    return next;
  }

  async settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await nextMacrotask();
  }

  /** Moves fake time forward in steps, letting async work finish after each step. */
  async advance(ms: number, stepMs = 250): Promise<void> {
    for (let left = ms; left > 0; left -= stepMs) {
      this.clock.advance(Math.min(stepMs, left));
      await this.settle(3);
    }
  }
}

export type { PeerId };
