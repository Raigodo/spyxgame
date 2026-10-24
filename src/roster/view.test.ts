import { describe, expect, it } from "vitest";
import { Cell, as, type PeerId, type PlayerId } from "@/kernel";
import { RecordingLogger } from "@/kernel/fakes";
import { createChangeEvents, createRosterView } from "./view";
import type { Player, RosterState } from "./model";

const peer = as<PeerId>;
const player = as<PlayerId>;

const stateOf = (bans: string[] = []): RosterState => ({
  entries: {
    p1: { name: "Ann", joinedAt: 1, peerId: peer("me"), link: "active" },
    p2: { name: "Bob", joinedAt: 2, peerId: peer("h"), link: "active" },
  },
  bans: bans.map(player),
});

function make() {
  const value = new Cell<RosterState | undefined>(undefined);
  const hostPeerId = new Cell<PeerId | undefined>(undefined);
  const view = createRosterView({
    value,
    localPlayerId: player("p1"),
    selfPeerId: peer("me"),
    hostPeerId,
  });
  return { value, hostPeerId, view };
}

describe("createRosterView", () => {
  it("before the first sync: no players, no me, nothing loaded", () => {
    const { view } = make();
    expect(view.players.get()).toEqual([]);
    expect(view.players.get()).toBe(view.players.get());
    expect(view.loaded.get()).toBeUndefined();
    expect(view.me.get()).toBeUndefined();
    expect(view.host.get()).toBeUndefined();
    expect(view.bans.get().size).toBe(0);
  });

  it("projects players, me and the host row", () => {
    const { value, hostPeerId, view } = make();
    value.set(stateOf());
    hostPeerId.set(peer("h"));
    expect(view.players.get().map((p) => p.name)).toEqual(["Ann", "Bob"]);
    expect(view.me.get()?.name).toBe("Ann");
    expect(view.me.get()?.presence).toBe("self");
    expect(view.host.get()?.name).toBe("Bob");
    hostPeerId.set(undefined);
    expect(view.host.get()).toBeUndefined();
  });

  it("keeps references while the content is equal", () => {
    const { value, view } = make();
    value.set(stateOf(["p9"]));
    const players = view.players.get();
    const me = view.me.get();
    const bans = view.bans.get();
    value.set(stateOf(["p9"]));
    expect(view.players.get()).toBe(players);
    expect(view.me.get()).toBe(me);
    expect(view.bans.get()).toBe(bans);
    expect(bans.has(player("p9"))).toBe(true);
  });

  it("changes references when something really changed", () => {
    const { value, view } = make();
    value.set(stateOf());
    const players = view.players.get();
    value.set({ ...stateOf(), entries: { p1: stateOf().entries.p1! } });
    expect(view.players.get()).not.toBe(players);
    expect(view.players.get()).toHaveLength(1);
  });
});

describe("createChangeEvents", () => {
  const P = (id: string, peerId?: string): Player => ({
    id: player(id),
    name: id,
    ...(peerId && { peerId: peer(peerId) }),
    presence: peerId ? "online" : "reconnecting",
    isHost: false,
    joinedAt: 1,
  });

  it("emits joined, rejoined and left after the first load, nothing for the load itself", () => {
    const source = new Cell<readonly Player[] | undefined>(undefined);
    const events = createChangeEvents(new RecordingLogger());
    const seen: string[] = [];
    events.joined.on((p) => seen.push(`joined:${p.id}`));
    events.rejoined.on((p) => seen.push(`rejoined:${p.id}`));
    events.left.on((e) => seen.push(`left:${e.player.id}:${e.reason}`));
    const stop = events.watch(source);

    source.set([P("a", "x")]);
    source.set([P("a", "x"), P("b", "y")]);
    source.set([P("a", "x"), P("b")]);
    source.set([P("a", "x"), P("b", "y2")]);
    source.set([P("a", "x")]);
    expect(seen).toEqual(["joined:b", "rejoined:b", "left:b:removed"]);

    stop();
    source.set([]);
    expect(seen).toHaveLength(3);
  });
});
