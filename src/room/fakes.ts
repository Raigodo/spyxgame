// In-memory harness for the room: N tabs, each with its own deps, over one fake Firestore, one fake
// RTC network and one fake clock. Waits with real setImmediate: never combine with
// vi.useFakeTimers().

import { as, type KeyValueStore, type PlayerId, type Result, type RoomId } from "@/kernel";
import {
  FakeClock,
  FakeIds,
  FakePageLifecycle,
  MemoryKeyValueStore,
  RecordingLogger,
  nextMacrotask,
} from "@/kernel/fakes";
import type { JoinError, RoomMembershipPort } from "@/transport";
import {
  FakeFirestoreState,
  FakeHostElection,
  FakeIceServerSource,
  FakePortLife,
  FakeRoomMembership,
  FakeRtcConnectionProvider,
  FakeRtcNetwork,
  FakeSignalInbox,
} from "@/transport/fakes";
import { DEFAULT_ROOM_CONFIG } from "./config";
import { joinRoom } from "./join";
import type { JoinedRoom, Room, RoomDeps } from "./model";
import { ScopedClock } from "@/kernel/scoped-clock";

export interface RoomTab {
  readonly name: string;
  readonly deps: RoomDeps;
  readonly tabStore: KeyValueStore;
  readonly profileStore: KeyValueStore;
  readonly pageLifecycle: FakePageLifecycle;
  /** Set by a successful join. */
  room?: Room;
  /** Abrupt death: no leave, no pagehide. Far ends notice after `detectionMs`. */
  kill(detectionMs?: number): void;
}

export interface TabParams {
  playerId?: string;
  nickname?: string;
}

export class RoomHarness {
  readonly clock = new FakeClock();
  readonly ids = new FakeIds();
  readonly logger = new RecordingLogger();
  readonly firestore = new FakeFirestoreState();
  readonly rtc = new FakeRtcNetwork(this.clock);

  addTab(
    name: string,
    options: { membership?: RoomMembershipPort; profileStore?: KeyValueStore } = {}
  ): RoomTab {
    const clock = new ScopedClock(this.clock);
    const life = new FakePortLife();
    const tabStore = new MemoryKeyValueStore();
    const profileStore = options.profileStore ?? new MemoryKeyValueStore();
    const pageLifecycle = new FakePageLifecycle();
    const deps: RoomDeps = {
      clock,
      ids: this.ids,
      log: this.logger.child(name),
      storages: { tab: tabStore, profile: profileStore },
      pageLifecycle,
      membership: options.membership ?? new FakeRoomMembership(this.firestore, life),
      inbox: new FakeSignalInbox(this.firestore, life),
      election: new FakeHostElection(this.firestore, life),
      connections: new FakeRtcConnectionProvider(this.rtc, name),
      iceServers: new FakeIceServerSource(),
      config: DEFAULT_ROOM_CONFIG,
    };
    return {
      name,
      deps,
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

  async tryJoin(
    tab: RoomTab,
    roomId: string,
    params: TabParams = {}
  ): Promise<Result<JoinedRoom, JoinError>> {
    const result = await joinRoom(tab.deps, {
      roomId: as<RoomId>(roomId),
      ...(params.playerId !== undefined && { playerId: as<PlayerId>(params.playerId) }),
      ...(params.nickname !== undefined && { nickname: params.nickname }),
    });
    if (result.ok) tab.room = result.value.room;
    await this.settle();
    return result;
  }

  async join(tab: RoomTab, roomId: string, params: TabParams = {}): Promise<JoinedRoom> {
    const result = await this.tryJoin(tab, roomId, params);
    if (!result.ok)
      throw new Error(`[harness] ${tab.name} failed to join: ${String(result.reason)}`);
    return result.value;
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
