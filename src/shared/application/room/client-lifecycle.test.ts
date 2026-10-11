import { describe, expect, it, vi } from "vitest";
import type { BusStatus } from "@/shared/application/messaging";
import { ClientLifecycle } from "./client-lifecycle";
import type { RoomPhase } from "./room-state";

function setup() {
  const state: { bus?: BusStatus; phase?: RoomPhase } = { bus: "syncing", phase: "lobby" };
  const lifecycle = new ClientLifecycle({
    getBusStatus: () => state.bus,
    getRoomPhase: () => state.phase,
  });
  return { lifecycle, state };
}

describe("ClientLifecycle", () => {
  it("maps lifecycle states to status, and joined follows the bus", () => {
    const { lifecycle, state } = setup();
    lifecycle.set("joining");
    lifecycle.sync();
    expect(lifecycle.getStatus()).toBe("joining");
    lifecycle.set("joined");
    lifecycle.sync();
    expect(lifecycle.getStatus()).toBe("syncing");
    state.bus = "ready";
    lifecycle.sync();
    expect(lifecycle.getStatus()).toBe("ready");
  });

  it("phase stays undefined until the first ready, then survives a re-sync", () => {
    const { lifecycle, state } = setup();
    lifecycle.set("joined");
    lifecycle.sync();
    expect(lifecycle.getPhase()).toBeUndefined();
    state.bus = "ready";
    lifecycle.sync();
    expect(lifecycle.getPhase()).toBe("lobby");
    state.bus = "syncing";
    lifecycle.sync();
    expect(lifecycle.getStatus()).toBe("syncing");
    expect(lifecycle.getPhase()).toBe("lobby");
  });

  it("notifies only on change, and resetSynced forgets the first ready", () => {
    const { lifecycle, state } = setup();
    const seen = vi.fn();
    lifecycle.onStatusChanged(seen);
    lifecycle.set("joined");
    state.bus = "ready";
    lifecycle.sync();
    lifecycle.sync();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(lifecycle.hasSynced()).toBe(true);
    lifecycle.resetSynced();
    expect(lifecycle.hasSynced()).toBe(false);
  });
});
