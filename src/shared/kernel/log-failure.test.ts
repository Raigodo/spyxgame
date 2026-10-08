import { expect, it } from "vitest";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { logFailure } from "./log-failure";

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
