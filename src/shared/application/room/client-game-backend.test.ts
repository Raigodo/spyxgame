import { describe, expect, it, vi } from "vitest";
import type { Slot } from "@/shared/application/game";
import { ClientGameBackend, NOT_JOINED, type GameParts } from "./client-game-backend";
import type { RoomState } from "./room-state";

const slot = { round: 1, state: { n: 1 } } as unknown as Slot;
const room = (over: Partial<RoomState> = {}): RoomState =>
  ({
    phase: "in-game",
    lobby: { mode: "free-for-all" },
    round: 1,
    game: { id: "g", config: null, context: {} },
    ...over,
  }) as unknown as RoomState;

function setup(opts: { room?: RoomState; synced?: boolean; joined?: boolean } = {}) {
  const parts = {
    runtime: { validateEvent: (name: string, data: unknown) => (name === "ok" ? data : undefined) },
    channel: { get: () => slot, send: vi.fn(async () => ({ ok: true as const })) },
    events: { broadcast: vi.fn(), sendTo: vi.fn() },
  } as unknown as GameParts;
  const backend = new ClientGameBackend({
    getRoomState: () => opts.room ?? room(),
    getGame: (id) => (opts.joined === false || id !== "g" ? undefined : parts),
    isSynced: () => opts.synced ?? true,
    getPlayerId: () => "me",
    start: async () => ({ ok: true }),
  });
  return { backend, parts };
}

describe("ClientGameBackend.getSlot", () => {
  it("returns the slot only for the current round of the active game, once synced", () => {
    expect(setup().backend.getSlot("g")).toBe(slot);
    expect(setup({ synced: false }).backend.getSlot("g")).toBeNull();
    expect(
      setup({ room: room({ phase: "lobby", game: undefined }) }).backend.getSlot("g")
    ).toBeNull();
    expect(setup({ room: room({ round: 2 }) }).backend.getSlot("g")).toBeNull();
    expect(setup().backend.getSlot("other")).toBeNull();
  });
});

describe("ClientGameBackend intents", () => {
  it("resolves as not joined when the game is unknown", async () => {
    await expect(setup({ joined: false }).backend.sendCommand("g", "tap", {})).resolves.toEqual(
      NOT_JOINED
    );
  });
  it("sends a valid event to everyone or to one peer, and refuses an invalid one", () => {
    const { backend, parts } = setup();
    expect(backend.sendEvent("g", "ok", { a: 1 })).toBe(true);
    expect(parts.events.broadcast).toHaveBeenCalledWith({ name: "ok", data: { a: 1 } });
    expect(backend.sendEvent("g", "ok", { a: 2 }, "p2")).toBe(true);
    expect(parts.events.sendTo).toHaveBeenCalledWith("p2", { name: "ok", data: { a: 2 } });
    expect(backend.sendEvent("g", "bad", {})).toBe(false);
    expect(setup({ joined: false }).backend.sendEvent("g", "ok", {})).toBe(false);
  });
});

describe("ClientGameBackend emitters", () => {
  it("delivers slot changes per game, and to every game on emitAllSlots", () => {
    const { backend } = setup();
    const g = vi.fn();
    const h = vi.fn();
    backend.onSlotChanged("g", g);
    backend.onSlotChanged("h", h);
    backend.emitSlot("g");
    expect(g).toHaveBeenCalledTimes(1);
    expect(h).not.toHaveBeenCalled();
    backend.emitAllSlots();
    expect(g).toHaveBeenCalledTimes(2);
    expect(h).toHaveBeenCalledTimes(1);
  });
  it("delivers events with name, data and sender, and stops after unsubscribe", () => {
    const { backend } = setup();
    const seen = vi.fn();
    const off = backend.onEvent("g", seen);
    backend.emitEvent("g", "emote", { e: 1 }, "p2");
    expect(seen).toHaveBeenCalledWith("emote", { e: 1 }, "p2");
    off();
    backend.emitEvent("g", "emote", {}, "p2");
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it("a throwing listener is reported and does not stop the others", () => {
    const errors: unknown[] = [];
    const backend = new ClientGameBackend(
      {
        getRoomState: () => undefined,
        getGame: () => undefined,
        isSynced: () => true,
        getPlayerId: () => undefined,
        start: async () => ({ ok: true }),
      },
      (e) => errors.push(e)
    );
    const seen = vi.fn();
    backend.onSlotChanged("g", () => {
      throw new Error("boom");
    });
    backend.onSlotChanged("g", seen);
    backend.emitSlot("g");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });
});
