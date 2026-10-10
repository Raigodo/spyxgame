import type { RegisteredGame } from "@/shared/application/game";
import {
  createMultiplayerClient,
  type JoinResult,
  type MultiplayerClient,
} from "@/shared/application/room";
import { MemoryKeyValueStore, type KeyValueStore } from "@/shared/kernel";
import { FakeClock } from "./fake-clock";
import { FakeFirestoreState } from "./fake-firestore-state";
import { FakeHostElection } from "./fake-host-election";
import { FakeIds } from "./fake-ids";
import { FakePageLifecycle } from "./fake-page-lifecycle";
import { FakePortLife } from "./fake-port-life";
import { FakeRoomMembership } from "./fake-room-membership";
import { FakeRtcConnectionProvider } from "./fake-rtc-connection-provider";
import { FakeRtcNetwork } from "./fake-rtc-network";
import { FakeSignalInbox } from "./fake-signal-inbox";
import { nextMacrotask } from "./next-macrotask";
import { RecordingLogger } from "./recording-logger";
import { ScopedClock } from "./scoped-clock";

export interface HarnessClientOptions {
  games?: readonly RegisteredGame[];
  /** Pass a previous tab's stores to simulate a refresh of the same tab / browser. */
  tabStore?: KeyValueStore;
  profileStore?: KeyValueStore;
}

export interface HarnessClient {
  readonly name: string;
  readonly client: MultiplayerClient;
  readonly games?: readonly RegisteredGame[];
  readonly tabStore: KeyValueStore;
  readonly profileStore: KeyValueStore;
  readonly pageLifecycle: FakePageLifecycle;
  /** Abrupt death: no leave, no pagehide. Timers stop; Firestore and links go silent. */
  kill(detectionMs?: number): void;
}

/**
 * N real MultiplayerClients over one fake Firestore, one fake RTC network and one fake clock.
 * Uses real setImmediate to let async work finish, so do not use vi.useFakeTimers() with it.
 *
 * Approximations: snapshot listeners fire before the write that caused them resolves; a first
 * snapshot arrives before the caller registers its handlers; a link opens when the offerer
 * applies the answer; ICE is a single fake candidate per description.
 */
export class RoomHarness {
  readonly clock = new FakeClock();
  readonly ids = new FakeIds();
  readonly logger = new RecordingLogger();
  readonly firestore = new FakeFirestoreState();
  readonly rtc = new FakeRtcNetwork(this.clock);

  addClient(name: string, options: HarnessClientOptions = {}): HarnessClient {
    const clock = new ScopedClock(this.clock);
    const life = new FakePortLife();
    const tabStore = options.tabStore ?? new MemoryKeyValueStore();
    const profileStore = options.profileStore ?? new MemoryKeyValueStore();
    const pageLifecycle = new FakePageLifecycle();
    const client = createMultiplayerClient(
      { games: options.games },
      {
        clock,
        ids: this.ids,
        logger: this.logger.child(name),
        membership: new FakeRoomMembership(this.firestore, life),
        messages: new FakeSignalInbox(this.firestore, life),
        election: new FakeHostElection(this.firestore, life),
        connections: new FakeRtcConnectionProvider(this.rtc, name),
        tabStore,
        profileStore,
        pageLifecycle,
      }
    );
    return {
      name,
      client,
      games: options.games,
      tabStore,
      profileStore,
      pageLifecycle,
      kill: (detectionMs) => {
        clock.kill();
        life.kill();
        this.rtc.kill(name, detectionMs);
      },
    };
  }

  async join(handle: HarnessClient, roomId: string, playerId?: string): Promise<JoinResult> {
    const result = await handle.client.join({ roomId, playerId });
    await this.settle();
    return result;
  }

  /** A page refresh: pagehide, the old tab dies, a new client rejoins with the same playerId. */
  async refresh(handle: HarnessClient, roomId: string): Promise<HarnessClient> {
    const playerId = handle.client.getPlayerId();
    handle.pageLifecycle.hide();
    handle.kill();
    const next = this.addClient(`${handle.name}'`, {
      games: handle.games,
      tabStore: handle.tabStore,
      profileStore: handle.profileStore,
    });
    await this.join(next, roomId, playerId);
    return next;
  }

  /** Lets pending promises, snapshots and macrotask work (fake ICE) finish. */
  async settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await nextMacrotask();
    }
  }

  /** Moves fake time forward in steps, letting async work finish after each step. */
  async advance(ms: number, stepMs = 250): Promise<void> {
    for (let left = ms; left > 0; left -= stepMs) {
      this.clock.advance(Math.min(stepMs, left));
      await this.settle(3);
    }
  }
}
