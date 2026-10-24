import { describe, expect, it } from "vitest";
import { emptyNotes, nextMark, spyNotes } from "./notes";

describe("nextMark", () => {
  it("cycles unknown, suspect, safe, unknown; undefined counts as unknown", () => {
    expect(nextMark(undefined)).toBe("suspect");
    expect(nextMark("unknown")).toBe("suspect");
    expect(nextMark("suspect")).toBe("safe");
    expect(nextMark("safe")).toBe("unknown");
  });
});

describe("spyNotes", () => {
  it("is a local state named `notes` starting empty (a fresh object each time)", () => {
    expect(spyNotes.id).toBe("notes");
    expect(spyNotes.initial()).toEqual({ pad: "", marks: {}, remarks: {} });
    expect(spyNotes.initial()).not.toBe(spyNotes.initial());
    expect(emptyNotes()).toEqual(spyNotes.initial());
  });
  it("its schema accepts empty notes and refuses garbage", () => {
    expect(spyNotes.schema.parse(emptyNotes())).toEqual(emptyNotes());
    expect(spyNotes.schema.parse({ pad: 1 })).toBeUndefined();
  });
});
