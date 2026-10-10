import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CookieStorageAdapter } from "./cookie-storage-adapter";

// A tiny cookie jar: parses "name=value; attrs", honours max-age=0, reads back "a=1; b=2".
function installFakeDocument(): Map<string, string> {
  const jar = new Map<string, string>();
  vi.stubGlobal("document", {
    get cookie() {
      return Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(line: string) {
      const [pair = "", ...attrs] = line.split("; ");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (attrs.includes("max-age=0")) jar.delete(name);
      else jar.set(name, value);
    },
  });
  return jar;
}

let jar: Map<string, string>;
beforeEach(() => {
  jar = installFakeDocument();
});
afterEach(() => vi.unstubAllGlobals());

it("round-trips a key with characters that would break a raw cookie name", () => {
  const store = new CookieStorageAdapter();
  const key = "player-profile:a;b=c d";
  store.set(key, '{"nickname":"x; y"}');
  expect(store.get(key)).toBe('{"nickname":"x; y"}');
  expect(Array.from(jar.keys()).every((name) => !/[;= ]/.test(name))).toBe(true);
});

it("keeps keys that share a prefix apart", () => {
  const store = new CookieStorageAdapter();
  store.set("a", "1");
  store.set("ab", "2");
  expect(store.get("a")).toBe("1");
  expect(store.get("ab")).toBe("2");
});

it("remove deletes only that key, and a missing key reads undefined", () => {
  const store = new CookieStorageAdapter();
  store.set("a", "1");
  store.set("b", "2");
  store.remove("a");
  expect(store.get("a")).toBeUndefined();
  expect(store.get("b")).toBe("2");
});
