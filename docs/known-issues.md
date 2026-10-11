# Known issues

- **Failover** takes about 5 to 8s (detection, 3s window, 0.7s confirm, link setup, recovery). `failover-timeline.test.ts` prints measured milestones; read them before changing a timer.
- **Reclaim** works for a refresh of the same tab only. Without a pagehide stamp the grace is about 2s after detection.
- **Duplicate arbitration** handles one pair per playerId and cannot tell which of two live duplicates is older.
- **Recovery:** a copy fresher than the adopted one, arriving after publish, is dropped. A live guest whose link takes longer than `recoveryLinkGraceMs` after promotion is not waited for. Applied marks are never pruned.
- **Reclaimed host self-restore** works only within `linkWaitMs` of promotion and only fills keys its profile lacks. History costs N-1 commands per departure.
- **Bans** last as long as the room. A banned player can appear in rosters briefly before removal is confirmed.
- **Signals:** a peer's invalid signals still count as acks (the ack happens before validation).
- **ICE batching** adds up to `iceBatchWindowMs` to link setup; unmeasured on real networks.
- **Firestore TTL** is stamped on new docs only. A live session older than 7 days loses its membership and host docs.
- Chunk length counts UTF-16 units, not bytes.
- Direct chat messages are readable by the host (star relay).
- Stale guest-to-guest links accumulate (small).
- **Dev only:** React StrictMode needs the provider's one-tick join delay; Fast Refresh calls `leave()` and forgets the host hint (test reclaim in a production build).
- `RoomNavigator` compares pathname to `/room/${roomId}${sub}`; room codes are restricted to `[A-Za-z0-9_-]{3,32}`.
- Test coverage: pure cores, classes and multi-peer scenarios on the harness. Link timing and ICE batching cannot be tested with the fakes.

Candidates, only if real usage asks for them: a separate reclaim delay (to shrink the election window further), a durable ban list.
