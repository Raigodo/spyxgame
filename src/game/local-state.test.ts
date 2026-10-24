import { describe, expect, it } from "vitest";
import { Cell, as, s, type KeyValueStore, type PlayerId, type RoomId } from "@/kernel";
import { createLocalState, defineLocalState } from "./local-state";

class Capturing implements KeyValueStore {
  readonly data = new Map<string, string>();
  lastTtl: number | undefined;
  get(key: string) {
    return this.data.get(key);
  }
  set(key: string, value: string, options?: { ttlMs?: number }) {
    this.data.set(key, value);
    this.lastTtl = options?.ttlMs;
  }
  remove(key: string) {
    this.data.delete(key);
  }
}

const def = defineLocalState({
  id: "notes",
  schema: s.object({ text: s.string({ max: 20 }) }),
  initial: () => ({ text: "" }),
});

function make() {
  const storage = new Capturing();
  const round = new Cell<number | undefined>(undefined);
  const local = createLocalState(
    {
      storage,
      roomId: as<RoomId>("r"),
      gameId: "probe",
      playerId: as<PlayerId>("a"),
      round,
      config: { localTtlMs: 1_000, maxLocalChars: 20 },
    },
    def
  );
  return { storage, round, local };
}

describe("defineLocalState", () => {
  it("accepts a valid id and throws on a bad one", () => {
    expect(defineLocalState(def)).toBe(def);
    for (const id of ["", "bad id!", "x".repeat(33)]) {
      expect(() => defineLocalState({ ...def, id })).toThrow(/Local state id/);
    }
  });
});

describe("createLocalState", () => {
  it("while no game is active: the initial value, and set is a no-op", () => {
    const { storage, local } = make();
    expect(local.value.get()).toEqual({ text: "" });
    local.set({ text: "x" });
    expect(storage.data.size).toBe(0);
  });

  it("stores per room, game, round, player and id, with the ttl", () => {
    const { storage, round, local } = make();
    round.set(1);
    local.set({ text: "hi" });
    expect(local.value.get()).toEqual({ text: "hi" });
    expect(storage.data.get("game-local:r:probe:1:a:notes")).toBe('{"text":"hi"}');
    expect(storage.lastTtl).toBe(1_000);
  });

  it("a new round starts fresh, and the old round's value is still there", () => {
    const { round, local } = make();
    round.set(1);
    local.set({ text: "one" });
    round.set(2);
    expect(local.value.get()).toEqual({ text: "" });
    round.set(1);
    expect(local.value.get()).toEqual({ text: "one" });
  });

  it("notifies on set and keeps the reference when the value is equal", () => {
    const { round, local } = make();
    round.set(1);
    local.set({ text: "a" });
    const first = local.value.get();
    const seen: unknown[] = [];
    local.value.subscribe((v) => seen.push(v));
    local.set({ text: "a" });
    expect(local.value.get()).toBe(first);
    local.set({ text: "b" });
    expect(seen).toEqual([{ text: "b" }]);
  });

  it("drops oversize values and ignores corrupt or invalid stored ones", () => {
    const { storage, round, local } = make();
    round.set(1);
    local.set({ text: "x".repeat(19) }); // serialized longer than 20
    expect(storage.data.size).toBe(0);
    storage.data.set("game-local:r:probe:1:a:notes", "not json");
    local.set({ text: "ok" });
    storage.data.set("game-local:r:probe:1:a:notes", "not json");
    round.set(2);
    round.set(1);
    expect(local.value.get()).toEqual({ text: "" });
    storage.data.set("game-local:r:probe:1:a:notes", '{"text":5}');
    round.set(2);
    round.set(1);
    expect(local.value.get()).toEqual({ text: "" });
  });
});
