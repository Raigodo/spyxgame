// Multi-peer harness: N real buses and game features over the bus fakes' star network and one
// fake clock. Peer name = peerId = playerId. Players are fed by hand through each peer's
// FakeGameInputs. The first peer added is host. Waits with real setImmediate: never combine with
// vi.useFakeTimers().

import { Scope, as, type PlayerId, type RoomId } from "@/kernel";
import {
  FakeClock,
  FakeEntropy,
  FakeIds,
  MemoryKeyValueStore,
  RecordingLogger,
  nextMacrotask,
} from "@/kernel/fakes";
import { DEFAULT_BUS_CONFIG, createBus, type Bus } from "@/bus";
import { FakeBusNetwork, type FakeTransport } from "@/bus/fakes";
import { DEFAULT_GAME_CONFIG, type GameConfig } from "./config";
import { createGame } from "./create-game";
import { FakeGameInputs } from "./fakes";
import type { GameApi, RegisteredGame, SlotSetup } from "./model";
import { makeSetup, probeGame } from "./test-kit";

export interface GamePeer {
  readonly name: string;
  readonly playerId: PlayerId;
  readonly transport: FakeTransport;
  readonly bus: Bus;
  readonly game: GameApi;
  readonly inputs: FakeGameInputs;
  readonly scope: Scope;
  /** Storages.device of this peer. */
  readonly device: MemoryKeyValueStore;
}

export class GameHarness {
  readonly clock = new FakeClock();
  readonly ids = new FakeIds();
  readonly log = new RecordingLogger();
  readonly network = new FakeBusNetwork();
  readonly peers: GamePeer[] = [];

  constructor(readonly roomId = "room1") {}

  addPeer(
    name: string,
    options: { games?: readonly RegisteredGame[]; config?: Partial<GameConfig> } = {}
  ): GamePeer {
    const transport = this.network.addPeer(name);
    const playerId = as<PlayerId>(name);
    const scope = new Scope({ onError: (e) => this.log.error("Cleanup failed", e) });
    const device = new MemoryKeyValueStore();
    const log = this.log.child(name);
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
    const inputs = new FakeGameInputs();
    const game = createGame(
      {
        bus,
        clock: this.clock,
        entropy: new FakeEntropy(),
        log: log.child("game"),
        storages: {
          tab: new MemoryKeyValueStore(),
          profile: new MemoryKeyValueStore(),
          device,
        },
        roomId: as<RoomId>(this.roomId),
        localPlayerId: playerId,
        role: transport.role,
        games: options.games ?? [probeGame],
        inputs: inputs.inputs,
        config: { ...DEFAULT_GAME_CONFIG, ...options.config },
      },
      scope.child()
    );
    bus.start();
    const peer: GamePeer = { name, playerId, transport, bus, game, inputs, scope, device };
    this.peers.push(peer);
    return peer;
  }

  /** These players are here, on every peer's inputs (any peer may become host). */
  seat(...names: string[]): void {
    for (const peer of this.peers) for (const name of names) peer.inputs.join(name);
  }

  setHere(name: string, here: boolean): void {
    for (const peer of this.peers) peer.inputs.setHere(name, here);
  }

  /** Kick or ban: emits `removed` and drops the player, on every peer. */
  remove(name: string): void {
    for (const peer of this.peers) peer.inputs.remove(name);
  }

  /** What `start` will read on whichever peer is host. */
  setup(participants: string[], extra: Partial<SlotSetup> = {}): void {
    const setup = makeSetup(participants, extra);
    for (const peer of this.peers) peer.inputs.setSetup(setup);
  }

  /** Abrupt death: links vanish, membership is removed, the peer's scope is disposed. */
  kill(peer: GamePeer): void {
    this.network.kill(peer.name);
    peer.scope.dispose();
    this.network.removeMember(peer.name);
  }

  setHost(name: string): void {
    this.network.setHost(name);
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
