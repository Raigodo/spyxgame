import { expect, it } from "vitest";
import { PresenceBook } from "./presence-book";

it("builds the status map with returning flags and forgets a peer completely", () => {
  const book = new PresenceBook();
  book.setStatus("a", "active");
  book.setStatus("b", "connecting");
  book.markReturning("b");
  expect(book.buildMap()).toEqual({
    a: { status: "active", returning: false },
    b: { status: "connecting", returning: true },
  });
  book.forgetPeer("b");
  expect(book.has("b")).toBe(false);
  expect(book.isReturning("b")).toBe(false);
});

it("clearHostState drops host data but keeps the host's last map; dispose drops everything", () => {
  const book = new PresenceBook();
  book.setStatus("a", "active");
  book.setRemote({ a: { status: "active", returning: false } });
  book.clearHostState();
  expect(book.has("a")).toBe(false);
  expect(book.remote("a")).toBeDefined();
  book.dispose();
  expect(book.remote("a")).toBeUndefined();
});
