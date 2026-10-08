import { expect, it, vi } from "vitest";
import { createConfig } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { PendingSignalAckTracker } from "./pending-signal-ack-tracker";
import type { SignalingMailbox } from "./signaling-mailbox";

it("logs instead of leaking a rejection when the pending check fails", async () => {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const config = createConfig().signaling;
  const mailbox = {
    isMessageStillPending: vi.fn().mockRejectedValue(new Error("boom")),
  } as unknown as SignalingMailbox;
  const tracker = new PendingSignalAckTracker({
    mailbox,
    clock,
    logger,
    config,
    onTimedOut: vi.fn(),
  });

  tracker.track("p", "m1", "remove");
  clock.advance(config.ackTimeoutMs);

  await vi.waitFor(() => expect(logger.messages("warn")).toContain("ack timeout check failed"));
});

it("times the peer out when the message is still pending", async () => {
  const clock = new FakeClock();
  const config = createConfig().signaling;
  const onTimedOut = vi.fn();
  const mailbox = {
    isMessageStillPending: vi.fn().mockResolvedValue(true),
  } as unknown as SignalingMailbox;
  const tracker = new PendingSignalAckTracker({
    mailbox,
    clock,
    logger: new RecordingLogger(),
    config,
    onTimedOut,
  });

  tracker.track("p", "m1", "remove");
  clock.advance(config.ackTimeoutMs);

  await vi.waitFor(() => expect(onTimedOut).toHaveBeenCalledWith("p"));
});
