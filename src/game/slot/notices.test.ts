import { describe, expect, it } from "vitest";
import { DEFAULT_GAME_CONFIG } from "../config";
import { makeSetup, parseEnv, slotEnv } from "../test-kit";
import { notices } from "./notices";

const said = (text: string) => ({ type: "said", text });
const setup = makeSetup(["a", "b"]);
const tight = { ...DEFAULT_GAME_CONFIG, maxNotices: 2 };

describe("notices.parse", () => {
  it("a missing key is the empty feed; garbage rejects the slot", () => {
    expect(notices.parse(undefined, setup, parseEnv())).toEqual({ seq: 0, list: [] });
    expect(notices.parse("x", setup, parseEnv())).toBeUndefined();
    expect(notices.parse({ seq: 1, list: "x" }, setup, parseEnv())).toBeUndefined();
    expect(notices.parse({ seq: -1, list: [] }, setup, parseEnv())).toBeUndefined();
  });

  it("drops notices the game's event schemas refuse, and ones without a valid seq", () => {
    const out = notices.parse(
      {
        seq: 3,
        list: [
          { seq: 1, event: said("ok") },
          { seq: 2, event: { type: "weird" } },
          { seq: 0, event: said("zero") },
          "junk",
        ],
      },
      setup,
      parseEnv()
    );
    expect(out).toEqual({ seq: 3, list: [{ seq: 1, event: said("ok") }] });
  });

  it("keeps only the newest notices and the highest seq", () => {
    const list = [1, 2, 3].map((seq) => ({ seq, event: said(`n${seq}`) }));
    const out = notices.parse({ seq: 1, list }, setup, { ...parseEnv(), config: tight });
    expect(out?.list.map((n) => n.seq)).toEqual([2, 3]);
    expect(out?.seq).toBe(3);
  });
});

describe("emit effect", () => {
  const apply = notices.effect!.apply;
  const emit = (event: unknown) => ({ type: "emit", event });

  it("appends with a rising seq", () => {
    const first = apply({ seq: 0, list: [] }, emit(said("hi")), slotEnv(), {} as never);
    expect(first).toEqual({ ok: true, value: { seq: 1, list: [{ seq: 1, event: said("hi") }] } });
    const second = apply(
      first.ok ? first.value : { seq: 0, list: [] },
      emit(said("yo")),
      slotEnv(),
      {} as never
    );
    expect(second.ok && second.value.seq).toBe(2);
  });

  it("an event the game does not know is an invalid effect", () => {
    expect(apply({ seq: 0, list: [] }, emit({ type: "weird" }), slotEnv(), {} as never)).toEqual({
      ok: false,
      reason: "invalid-effect",
    });
  });

  it("keeps only the newest notices", () => {
    let x = { seq: 0, list: [] as { seq: number; event: unknown }[] };
    for (const t of ["a", "b", "c"]) {
      const out = apply(x, emit(said(t)), slotEnv({ config: tight }), {} as never);
      if (out.ok) x = out.value;
    }
    expect(x.list.map((n) => n.seq)).toEqual([2, 3]);
    expect(x.seq).toBe(3);
  });
});
