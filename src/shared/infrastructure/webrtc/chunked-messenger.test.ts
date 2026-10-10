import { describe, expect, it } from "vitest";
import { createConfig } from "@/shared/kernel";
import { FakeClock } from "@/shared/testing/fake-clock";
import { FakeIds } from "@/shared/testing/fake-ids";
import { RecordingLogger } from "@/shared/testing/recording-logger";
import { ChunkedMessenger, type RawMessaging } from "./chunked-messenger";

const invalidChunk = JSON.stringify({
  __chunk: true,
  messageId: "m",
  index: 9,
  total: 2,
  data: "x",
});

function setup() {
  let deliver: (raw: string, from: string) => void = () => {};
  const rtc: RawMessaging = {
    onMessage: (handler) => {
      deliver = handler;
      return () => {};
    },
    sendMessageToPeer: () => {},
    broadcastMessage: () => {},
  };
  const logger = new RecordingLogger();
  const clock = new FakeClock();
  const messenger = new ChunkedMessenger({
    rtc,
    clock,
    ids: new FakeIds(),
    logger,
    config: createConfig().webrtc,
  });
  const received: string[] = [];
  messenger.onMessage((message) => received.push(message));
  return { send: (raw: string, from: string) => deliver(raw, from), logger, clock, received };
}

describe("ChunkedMessenger incoming", () => {
  it("passes plain messages through", () => {
    const { send, received } = setup();
    send("hello", "p1");
    expect(received).toEqual(["hello"]);
  });
  it("warns about an invalid chunk with the sender and delivers nothing", () => {
    const { send, logger, received } = setup();
    send(invalidChunk, "p1");
    expect(received).toEqual([]);
    expect(logger.entries[0]).toMatchObject({
      level: "warn",
      message: "Dropped invalid chunk",
      data: { from: "p1" },
    });
  });
  it("throttles repeats per sender", () => {
    const { send, logger, clock } = setup();
    send(invalidChunk, "p1");
    send(invalidChunk, "p1");
    expect(logger.messages("warn")).toHaveLength(1);
    clock.advance(5_000);
    send(invalidChunk, "p1");
    expect(logger.entries).toHaveLength(2);
    expect(logger.entries[1]?.data).toEqual({ from: "p1", suppressed: 1 });
  });
});
