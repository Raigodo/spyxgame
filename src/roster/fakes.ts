// In-memory harness: N real buses and rosters over the bus fakes' star network and one fake clock.
// Membership removal is NOT automatic (the bus fake models no election): kill()/refresh() remove
// the dead peer's membership by default, as the host would after suspecting it.
// Waits with real setImmediate: never combine with vi.useFakeTimers().

import { Scope, as, type PeerId, type PlayerId, type Store } from "@/kernel";
import { FakeClock, FakeIds, MemoryKeyValueStore, RecordingLogger } from "@/kernel/fakes";
import { DEFAULT_BUS_CONFIG, createBus, type Bus } from "@/bus";
import { FakeBusNetwork, type FakeTransport } from "@/bus/fakes";
import { DEFAULT_ROSTER_CONFIG } from "./config";
import { createRoster } from "./create-roster";
import type { Player, Roster } from "./model";

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface HarnessPeer {
  readonly name: string;
  readonly peerId: PeerId;
  readonly playerId: PlayerId;
  readonly transport: FakeTransport;
  readonly bus: Bus;
  readonly roster: Roster;
  readonly scope: Scope;
  readonly profileStore: MemoryKeyValueStore;
}

export interface AddPeerOptions {
  playerId?: string;
  nickname?: string;
  /** Pass a previous tab's store to simulate a refresh of the same browser. */
  profileStore?: MemoryKeyValueStore;
}

export class RosterHarness {
  readonly clock = new FakeClock();
  readonly ids = new FakeIds();
  readonly log = new RecordingLogger();
  readonly network = new FakeBusNetwork();
  private nextPlayer = 0;

  /** The first peer added becomes host. Roster flows start with the bus. */
  addPeer(name: string, options: AddPeerOptions = {}): HarnessPeer {
    const playerId = as<PlayerId>(options.playerId ?? `player-${name}-${++this.nextPlayer}`);
    const transport = this.network.addPeer(name, playerId);
    const scope = new Scope({ onError: (e) => this.log.error("Cleanup failed", e) });
    const log = this.log.child(name);
    const profileStore = options.profileStore ?? new MemoryKeyValueStore();

    const bus = createBus(
      {
        transport,
        localPlayerId: playerId,
        clock: this.clock,
        ids: this.ids,
        log: log.child("bus"),
        config: DEFAULT_BUS_CONFIG,
      },
      scope
    );
    const roster = createRoster(
      {
        transport,
        bus,
        localPlayerId: playerId,
        nickname: options.nickname ?? name,
        clock: this.clock,
        ids: this.ids,
        log: log.child("roster"),
        storages: { profile: profileStore },
        config: DEFAULT_ROSTER_CONFIG,
      },
      scope.child()
    );
    bus.start();
    return {
      name,
      peerId: transport.self,
      playerId,
      transport,
      bus,
      roster,
      scope,
      profileStore,
    };
  }

  /** Makes `name` host (links to every live peer, never closes links). */
  setHost(name: string): void {
    this.network.setHost(name);
  }

  /**
   * Abrupt death: no leave, links vanish, its timers stop. `removeMember: false` keeps its
   * membership (a dead tab nobody has removed yet).
   */
  kill(peer: HarnessPeer, options: { removeMember?: boolean } = {}): void {
    this.network.kill(peer.name);
    peer.scope.dispose();
    if (options.removeMember !== false) this.network.removeMember(peer.name);
  }

  /** A page refresh: the old tab dies, a new peer with the same playerId and profile store joins. */
  async refresh(peer: HarnessPeer): Promise<HarnessPeer> {
    this.kill(peer);
    const next = this.addPeer(`${peer.name}'`, {
      playerId: peer.playerId,
      profileStore: peer.profileStore,
    });
    await this.settle();
    return next;
  }

  /** Lets pending promises and macrotask work finish. */
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

/** Current value of a store, for assertions. */
export const read = <T>(store: Store<T>): T => store.get();

export const names = (players: readonly Player[]): string[] => players.map((p) => p.name);
