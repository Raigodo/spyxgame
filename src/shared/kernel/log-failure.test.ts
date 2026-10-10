import { expect, it, vi } from "vitest";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { Emitter } from "./emitter";
import { listenerFailure, logFailure } from "./log-failure";

it("logs a warning with the error attached", async () => {
  const log = new RecordingLogger();
  const error = new Error("boom");
  await Promise.reject(error).catch(logFailure(log, "send offer"));
  expect(log.entries[0]).toMatchObject({
    level: "warn",
    message: "send offer failed",
    data: error,
  });
});

it("listenerFailure logs an error and the emitter keeps going", () => {
  const log = new RecordingLogger();
  const seen = vi.fn();
  const emitter = new Emitter<number>(listenerFailure(() => log));
  emitter.on(() => {
    throw new Error("boom");
  });
  emitter.on(seen);
  emitter.emit(1);
  expect(seen).toHaveBeenCalledWith(1);
  expect(log.entries[0]).toMatchObject({ level: "error", message: "Listener failed" });
});
