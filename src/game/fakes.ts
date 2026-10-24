// Fakes for code built on the game feature, usable before `createGame` exists:
//  - FakeGameInputs: the stores room wires into game (players, removed, setup).
//  - FakeGameApi / FakeGameHandle: a hand-driven GameApi for ui and room tests.
// The real multi-peer harness (real bus on FakeBusNetwork) comes with createGame, in G3.

import {
  Cell,
  Emitter,
  as,
  ok,
  type Listenable,
  type PeerId,
  type PlayerId,
  type Result,
  type Store,
} from "@/kernel";
import type { BusFailure } from "@/bus";
import type {
  ActiveGame,
  ContinueReject,
  EndReject,
  GameApi,
  GameDef,
  GameHandle,
  GameTypes,
  GameView,
  InputPlayer,
  LastGame,
  LocalStateDef,
  PlayError,
  SlotSetup,
  StartReject,
} from "./model";

const EMPTY_SETUP: SlotSetup = {
  mode: "free-for-all",
  teams: {},
  participants: [],
  spectators: [],
  names: {},
};

/** What room wires into `GameDeps.inputs`. Drive it from a test, read `.inputs` in the deps. */
export class FakeGameInputs {
  private readonly playersCell = new Cell<readonly InputPlayer[]>([]);
  private readonly removedEmitter = new Emitter<PlayerId>();
  private readonly setupCell = new Cell<SlotSetup>(EMPTY_SETUP);

  readonly inputs = {
    players: this.playersCell as Store<readonly InputPlayer[]>,
    removed: this.removedEmitter as Listenable<PlayerId>,
    setup: this.setupCell as Store<SlotSetup>,
  };

  setPlayers(players: readonly InputPlayer[]): void {
    this.playersCell.set(players);
  }

  /** Adds (or replaces) a player who is here. */
  join(id: string, name: string = id, peerId: string = id): void {
    const player: InputPlayer = {
      id: as<PlayerId>(id),
      name,
      here: true,
      peerId: as<PeerId>(peerId),
    };
    this.playersCell.update((list) => [...list.filter((p) => p.id !== player.id), player]);
  }

  /** A ghost (`here` false, no peer) or a returning player (`here` true). */
  setHere(id: string, here: boolean): void {
    this.playersCell.update((list) =>
      list.map((p) =>
        p.id !== id
          ? p
          : { id: p.id, name: p.name, here, ...(here && p.peerId && { peerId: p.peerId }) }
      )
    );
  }

  /** Kick or ban: emits `removed` and drops the player. */
  remove(id: string): void {
    this.playersCell.update((list) => list.filter((p) => p.id !== id));
    this.removedEmitter.emit(as<PlayerId>(id));
  }

  setSetup(setup: Partial<SlotSetup>): void {
    this.setupCell.update((current) => ({ ...current, ...setup }));
  }
}

/** A complete view with defaults, for tests that only care about a few fields. */
export function makeView<T extends GameTypes>(
  parts: Pick<GameView<T>, "state" | "settings"> & Partial<GameView<T>>
): GameView<T> {
  return {
    round: 1,
    setup: { mode: "free-for-all", participants: [] } as unknown as GameView<T>["setup"],
    me: { playerId: as<PlayerId>("me"), role: "player" },
    players: [],
    away: [],
    paused: false,
    notices: [],
    timers: [],
    ...parts,
  };
}

type Sent<T extends GameTypes> = { event: T["event"]; from: PeerId };

export class FakeGameHandle<T extends GameTypes> implements GameHandle<T> {
  private readonly viewCell = new Cell<GameView<T> | undefined>(undefined);
  private readonly eventEmitter = new Emitter<Sent<T>>();
  private readonly noticeEmitter = new Emitter<{ event: T["event"] }>();
  private readonly locals = new Map<string, Cell<unknown>>();

  readonly view: Store<GameView<T> | undefined> = this.viewCell;
  readonly events: Listenable<Sent<T>> = this.eventEmitter;
  readonly noticed: Listenable<T["event"]> = {
    on: (fn) => this.noticeEmitter.on(({ event }) => fn(event)),
  };

  /** What the next `send`, `continueAnyway` resolve with, and what `broadcast`/`sendTo` return. */
  sendResult: Result<void, T["reject"] | PlayError | BusFailure> = ok();
  continueResult: Result<void, ContinueReject> = ok();
  accepting = true;

  readonly sent: T["command"][] = [];
  readonly broadcasts: T["event"][] = [];
  readonly sentTo: { id: PlayerId; event: T["event"] }[] = [];
  continueCalls = 0;

  setView(view: GameView<T> | undefined): void {
    this.viewCell.set(view);
  }

  emitEvent(event: T["event"], from: string = "peer"): void {
    this.eventEmitter.emit({ event, from: as<PeerId>(from) });
  }

  emitNotice(event: T["event"]): void {
    this.noticeEmitter.emit({ event });
  }

  send(command: T["command"]): Promise<Result<void, T["reject"] | PlayError | BusFailure>> {
    this.sent.push(command);
    return Promise.resolve(this.sendResult);
  }

  broadcast(event: T["event"]): boolean {
    if (this.accepting) this.broadcasts.push(event);
    return this.accepting;
  }

  sendTo(id: PlayerId, event: T["event"]): boolean {
    if (this.accepting) this.sentTo.push({ id, event });
    return this.accepting;
  }

  continueAnyway(): Promise<Result<void, ContinueReject>> {
    this.continueCalls += 1;
    return Promise.resolve(this.continueResult);
  }

  local<L>(def: LocalStateDef<L>): { value: Store<L>; set(next: L): void } {
    let cell = this.locals.get(def.id) as Cell<L> | undefined;
    if (!cell) {
      cell = new Cell<L>(def.initial());
      this.locals.set(def.id, cell as Cell<unknown>);
    }
    const stored = cell;
    return { value: stored, set: (next) => void stored.set(next) };
  }
}

export class FakeGameApi implements GameApi {
  private readonly activeCell = new Cell<ActiveGame | undefined>(undefined);
  private readonly lastCell = new Cell<LastGame | undefined>(undefined);
  private readonly roundCell = new Cell<number | undefined>(undefined);
  private readonly handles = new Map<string, FakeGameHandle<GameTypes>>();

  /** What the next `start` and `end` resolve with. */
  startResult: Result<void, StartReject> = ok();
  endResult: Result<void, EndReject> = ok();

  readonly starts: { gameId: string; settings: unknown }[] = [];
  endCalls = 0;

  readonly state = {
    active: this.activeCell as Store<ActiveGame | undefined>,
    last: this.lastCell as Store<LastGame | undefined>,
    round: this.roundCell as Store<number | undefined>,
  };

  readonly actions: GameApi["actions"] = {
    start: <T extends GameTypes>(def: GameDef<T>, settings: T["settings"]) => {
      this.starts.push({ gameId: def.id, settings });
      return Promise.resolve(this.startResult);
    },
    end: () => {
      this.endCalls += 1;
      return Promise.resolve(this.endResult);
    },
    handle: <T extends GameTypes>(def: GameDef<T>) => this.handleOf(def),
  };

  setActive(active: ActiveGame | undefined): void {
    this.activeCell.set(active);
  }

  setLast(last: LastGame | undefined): void {
    this.lastCell.set(last);
  }

  setRound(round: number | undefined): void {
    this.roundCell.set(round);
  }

  /** The same fake handle for the same def id, with test controls. */
  handleOf<T extends GameTypes>(def: GameDef<T>): FakeGameHandle<T> {
    let handle = this.handles.get(def.id);
    if (!handle) {
      handle = new FakeGameHandle<GameTypes>();
      this.handles.set(def.id, handle);
    }
    return handle as unknown as FakeGameHandle<T>;
  }
}
