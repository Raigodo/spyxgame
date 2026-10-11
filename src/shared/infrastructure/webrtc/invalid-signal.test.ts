import { expect, it } from "vitest";
import { nextMacrotask } from "@/shared/testing/next-macrotask";
import { RoomHarness } from "@/shared/testing/room-harness";

it("an invalid signal is dropped with a warning and its inbox doc is still deleted", async () => {
  const h = new RoomHarness();
  const a = h.addClient("a");
  await h.join(a, "room1");
  const me = a.client.getLocalPeerId() ?? "";

  const inbox = h.firestore.inbox("room1", me);
  inbox.set("bad1", {
    id: "bad1",
    fromPeerId: "intruder",
    toPeerId: me,
    timestamp: new Date(0),
    payload: { type: "offer" }, // no sdp
  });
  h.firestore.changed("room1", `inbox:${me}`);
  await nextMacrotask();
  await h.settle();

  expect(h.logger.messages("warn")).toContain("Dropped invalid signal");
  expect(inbox.has("bad1")).toBe(false);
});
