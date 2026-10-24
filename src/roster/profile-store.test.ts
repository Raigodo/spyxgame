import { describe, expect, it } from "vitest";
import { MemoryKeyValueStore } from "@/kernel/fakes";
import { createProfileStore, pickName } from "./profile-store";

describe("pickName", () => {
  it("explicit wins, trimmed", () => {
    expect(pickName("  Ann ", "Bob", "Player", 10)).toBe("Ann");
  });
  it("a blank explicit name falls back to the remembered one, then the default", () => {
    expect(pickName("  ", "Bob", "Player", 10)).toBe("Bob");
    expect(pickName(undefined, "  ", "Player", 10)).toBe("Player");
    expect(pickName(undefined, undefined, "Player", 10)).toBe("Player");
  });
  it("is cut to the max length", () => {
    expect(pickName("Annabelle", undefined, "Player", 3)).toBe("Ann");
    expect(pickName(undefined, undefined, "Player", 3)).toBe("Pla");
  });
});

describe("createProfileStore", () => {
  it("saves and loads the nickname", () => {
    const profile = createProfileStore(new MemoryKeyValueStore(), 1_000);
    expect(profile.loadName()).toBeUndefined();
    profile.saveName("Ann");
    expect(profile.loadName()).toBe("Ann");
  });
});
