import { expect, it } from "vitest";
import { recordMilestones } from "./milestones";
import { RoomHarness } from "./room-harness";

const ROOM = "room1";

it("elects a surviving guest right after the window even when several guests died with the host", async () => {
  const h = new RoomHarness();
  const a = h.addClient("a");
  const b = h.addClient("b");
  const c = h.addClient("c");
  const d = h.addClient("d");
  const e = h.addClient("e");
  const f = h.addClient("f");
  for (const client of [a, b, c, d, e, f]) await h.join(client, ROOM);

  const survivorId = b.client.getLocalPeerId() ?? "";
  const deadIds = [c, d, e].map((x) => x.client.getLocalPeerId());

  for (const client of [a, c, d, e]) client.kill(1_000);

  const t = await recordMilestones(
    h,
    {
      hostWritten: () => h.firestore.room(ROOM).host?.signalingPeerId === survivorId,
      becameHost: () => b.client.isHost(),
    },
    20_000
  );
  console.info("[timeline] host and three guests die", t);

  // Detection 1s + window 3s + confirm 0.7s, with some slack. Not 1.5s per dead candidate.
  expect(t.hostWritten).toBeDefined();
  expect(t.hostWritten ?? Infinity).toBeLessThan(7_000);
  expect(deadIds).not.toContain(h.firestore.room(ROOM).host?.signalingPeerId);
  expect(t.becameHost).toBeDefined();
  expect(f.client.isHost()).toBe(false);
});
