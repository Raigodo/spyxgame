# Known issues, status and next

Read to see what is broken, missing or planned, before proposing work.

## Status and next

Status was inferred from the code, so check it. Corrections welcome.

**Done:** strict TypeScript, Vitest harness, ports and adapters everywhere, composition root, host reclaim, ghost rows, the class splits (WebRTC host role, reclaim controller, signal router, dead-host election, bus recovery, presence coordinator, client helpers), `lastGame` restore, the game framework (names, away, pause, effects, timers, local and private state, versioning).

**Next:**

- Membership self-heal and a delayed stale-link prune.
- UI rework (the pages are placeholders; spy's secrets still rely on UI hiding).
- Tests for the game framework (presence, effects, timers, private state). None written yet by agreement.
- Optional: convert spy's `word` and `spyId` to private pieces.

**Candidates, only if real usage asks:** a separate reclaim delay (to shrink the election window further), a durable ban list, per-peer clock-offset estimation for timers.

## Failover and links

- Failover takes about 5 to 8s (detection, 3s window, 0.7s confirm, link setup, recovery).
- A browser-reported `disconnected` counts as dead immediately, which can cause false elections on flaky VPN or Wi-Fi. A `disconnectGraceMs` grace was proposed; check whether it is applied before relying on it. `offerTimeoutMs` (12s) is the highest false-positive timer.
- Reclaim works for a refresh of the same tab only. Without a `pagehide` stamp the grace is about 2s after detection.
- Stale guest-to-guest links accumulate (small).
- ICE batching adds up to `iceBatchWindowMs` to link setup. Unmeasured on real networks.
- Firestore may fall back to slow long-polling behind some proxies. Consider `experimentalAutoDetectLongPolling` only if observed.

## TURN

- `/api/turn` is public, so anyone can mint relay credentials from your Cloudflare key. Add a Vercel firewall rate limit and watch Cloudflare usage.
- Credentials live 24h, so a longer session cannot build new relay links after a reconnect.

## Bus and presence

- Duplicate arbitration handles one pair per `playerId` and cannot tell which of two live duplicates is older.
- Recovery: a copy fresher than the adopted one, arriving after publish, is dropped. A live guest whose link takes longer than `recoveryLinkGraceMs` is not waited for. Applied marks are never pruned.
- A reclaimed host restores itself only within `linkWaitMs` of promotion, and only fills keys it lacks. History costs N-1 commands per departure.
- Bans last as long as the room. A banned player can appear in rosters briefly before removal is confirmed.
- A peer's invalid signals still count as acks (the ack happens before validation).
- Chunk length counts UTF-16 units, not bytes. Direct chat messages are readable by the host.
- Firestore TTL is stamped on new docs only. A live session older than 7 days loses its membership and host docs.

## Games framework

- The host can read every private piece. The host's own piece survives a refresh only through `recover`. A guest with a slow link at failover may have its piece regenerated.
- Kick and ban drop a player at once only if the host stays up; otherwise the 10s away path applies.
- Timer deadlines use the host's clock. Guest countdowns show device-clock skew (typically about a second).
- A guest on an older build than the host stays syncing until it reloads.
- Local game state expires only when read, so unread expired keys stay in localStorage. Old `spy-notes:` keys from before local state are orphaned.
- Spy: with an away spy in `lastChance`, the host must `forceAdvance` (or `endGame`). Spectators see neither word nor spy until the end, by UI only.

## Repo hygiene (found while reading the files)

- `.github/workflows/deploy.yml` starts and ends with markdown code fences, so it is not valid YAML. It also uses Node 20 and pnpm 10 while `package.json` pins `pnpm@11.10.0` and Vitest and lint-staged need Node 22 or newer.
- `verceel.json` is misspelled, so Vercel ignores it (including `deploymentEnabled: false`).
- `next.config.ts` and a few files may not be Prettier-formatted.

## Dev only

- React StrictMode needs the provider's one-tick join delay. Fast Refresh calls `leave()` and forgets the host hint: test reclaim in a production build.
- `RoomNavigator` compares pathname to `/room/${roomId}${sub}`, so room codes are restricted to `[A-Za-z0-9_-]{3,32}`.
- Test coverage: pure cores, classes and multi-peer scenarios on the harness. See [concepts/testing.md](./concepts/testing.md) for what the fakes cannot show.
