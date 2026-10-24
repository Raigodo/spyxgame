import { describe, expect, it } from "vitest";
import { FakeClock, RecordingLogger } from "@/kernel/fakes";
import type { IceServer } from "../config";
import type { IceServerSource } from "../ports";
import { resolveIceServers } from "./ice-servers";

const fallback: IceServer[] = [{ urls: "stun:fallback" }];
const relay: IceServer[] = [{ urls: "turn:relay", username: "u", credential: "c" }];

const run = (source: IceServerSource, clock = new FakeClock()) => ({
  clock,
  promise: resolveIceServers({
    source,
    clock,
    logger: new RecordingLogger(),
    fallback,
    timeoutMs: 4_000,
  }),
});

describe("resolveIceServers", () => {
  it("returns the fetched servers", async () => {
    expect(await run({ fetch: async () => relay }).promise).toEqual(relay);
  });
  it("falls back on an empty answer", async () => {
    expect(await run({ fetch: async () => [] }).promise).toEqual(fallback);
  });
  it("falls back, without rejecting, when the fetch throws", async () => {
    const { promise } = run({
      fetch: () => Promise.reject(new Error("net")),
    });
    expect(await promise).toEqual(fallback);
  });
  it("falls back on timeout", async () => {
    const { clock, promise } = run({ fetch: () => new Promise(() => {}) });
    clock.advance(4_000);
    expect(await promise).toEqual(fallback);
  });
});
