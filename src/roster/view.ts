// The roster's read side: derived stores (stable references, change only on real change) and the
// joined / rejoined / left events produced by diffing the player list.
// No bus, no transport: it takes the replicated value and the host peer as injected Stores.

import {
  Emitter,
  derived,
  listenerFailure,
  structurallyEqual,
  type Listenable,
  type Logger,
  type PeerId,
  type PlayerId,
  type Store,
  type Unsubscribe,
} from "@/kernel";
import { diffPlayers } from "./changes";
import type { Player, RosterState } from "./model";
import { entriesToPlayers } from "./rules";

export interface RosterViewDeps {
  /** The replicated roster; undefined until first synced. */
  value: Store<RosterState | undefined>;
  localPlayerId: PlayerId;
  selfPeerId: PeerId;
  hostPeerId: Store<PeerId | undefined>;
}

export interface RosterView {
  players: Store<readonly Player[]>;
  me: Store<Player | undefined>;
  host: Store<Player | undefined>;
  bans: Store<ReadonlySet<PlayerId>>;
  /** Players before the first sync is `undefined`: nothing is announced for the initial load. */
  loaded: Store<readonly Player[] | undefined>;
}

const NO_PLAYERS: readonly Player[] = [];
const NO_BANS: ReadonlySet<PlayerId> = new Set();

/** Returns the previous reference while the new value is structurally equal. */
function stable<T>(): (next: T) => T {
  let last: { value: T } | undefined;
  return (next) => {
    if (last && structurallyEqual(last.value, next)) return last.value;
    last = { value: next };
    return next;
  };
}

export function createRosterView(deps: RosterViewDeps): RosterView {
  const keepLoaded = stable<readonly Player[] | undefined>();
  const loaded = derived([deps.value, deps.hostPeerId], (state, hostPeerId) =>
    keepLoaded(
      state ? entriesToPlayers(state, { selfPeerId: deps.selfPeerId, hostPeerId }) : undefined
    )
  );
  const players = derived([loaded], (list) => list ?? NO_PLAYERS);

  const keepMe = stable<Player | undefined>();
  const me = derived([players], (list) => keepMe(list.find((p) => p.id === deps.localPlayerId)));

  const keepHost = stable<Player | undefined>();
  const host = derived([players], (list) => keepHost(list.find((p) => p.isHost)));

  const keepBans = stable<readonly PlayerId[]>();
  const banList = derived([deps.value], (state) => keepBans(state?.bans ?? []));
  const keepBanSet = stable<ReadonlySet<PlayerId>>();
  const bans = derived([banList], (list) => (list.length ? keepBanSet(new Set(list)) : NO_BANS));

  return { players, me, host, bans, loaded };
}

export interface ChangeEvents {
  joined: Listenable<Player>;
  rejoined: Listenable<Player>;
  left: Listenable<{ player: Player; reason: "expired" | "removed" }>;
  /** Starts diffing `source`. Returns the unsubscribe; register it with the owning scope. */
  watch(source: Store<readonly Player[] | undefined>): Unsubscribe;
}

export function createChangeEvents(log: Logger): ChangeEvents {
  const onError = listenerFailure(() => log);
  const joined = new Emitter<Player>(onError);
  const rejoined = new Emitter<Player>(onError);
  const left = new Emitter<{ player: Player; reason: "expired" | "removed" }>(onError);

  return {
    joined,
    rejoined,
    left,
    watch(source) {
      let prev = source.get();
      return source.subscribe(() => {
        const next = source.get();
        if (next === prev) return;
        const changes = next ? diffPlayers(prev, next) : [];
        prev = next;
        for (const change of changes) {
          if (change.kind === "joined") joined.emit(change.player);
          else if (change.kind === "rejoined") rejoined.emit(change.player);
          else left.emit({ player: change.player, reason: change.reason });
        }
      });
    },
  };
}
