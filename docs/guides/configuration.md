# Configuration

Read before changing a number. All durations are **milliseconds**. Defaults live in each layer's `config.ts`; override through `RoomDeps.config`. A `destructive` timer can remove a live peer when it is too short.

## Transport (signaling)

| Key                           | Default   | Meaning                                                                     |
| ----------------------------- | --------- | --------------------------------------------------------------------------- |
| `candidateCollectionWindowMs` | 3000 (d)  | Election: time to gather candidates before removing the dead host           |
| `candidateConfirmWindowMs`    | 700       | Election: wait for confirmations                                            |
| `positionIntervalMs`          | 1500      | Election: delay per position in the order                                   |
| `ackTimeoutMs`                | 15000 (d) | Unread signal before the recipient is removed (vetoed by an active channel) |
| `messageRetentionMs`          | 1 h       | Signal TTL                                                                  |
| `candidateRetentionMs`        | 1 h       | Candidate TTL                                                               |
| `roomRetentionMs`             | 7 d (d)   | Room TTL                                                                    |

## Transport (link)

| Key                                                             | Default              | Meaning                                       |
| --------------------------------------------------------------- | -------------------- | --------------------------------------------- |
| `iceFetchTimeoutMs`                                             | 4000                 | ICE server fetch, then STUN fallback          |
| `offerTimeoutMs`                                                | 12000 (d)            | Wait for the host's offer                     |
| `reconnectTimeoutMs`                                            | 5000                 | Guest reconnect attempt                       |
| `reclaimWindowMs`                                               | 10000                | Reclaim retry window                          |
| `byeFlushMs`                                                    | 500                  | Wait after `bye` before closing               |
| `hostClaimMaxAgeMs`                                             | 15000                | Trusted age of the pagehide stamp             |
| `iceBatchWindowMs` / `iceMaxBatch`                              | 300 / 20             | ICE candidate batching                        |
| `probeIdleMs` / `probeTimeoutMs`                                | 10000 (d) / 5000 (d) | Host probes of idle links                     |
| `disconnectGraceMs`                                             | 3000 (d)             | `disconnected` before the link counts as dead |
| `chunkBufferTtlMs`                                              | 30000                | Incomplete chunked message dropped after      |
| `maxChunkChars` / `maxChunksPerMessage`                         | 12000 / 256          | Max message 3,072,000 chars                   |
| `maxSdpChars`, `maxCandidateChars`, `maxIceCandidatesPerSignal` | 100000, 4000, 50     | Signal validation                             |

## Bus

| Key                   | Default   | Meaning                             |
| --------------------- | --------- | ----------------------------------- |
| `commandTtlMs`        | 30000     | How long a command is retried       |
| `recoveryWindowMs`    | 3000      | Sliding window after the last offer |
| `recoveryMaxMs`       | 10000     | Cap on recovery                     |
| `recoveryLinkGraceMs` | 2000      | Wait for reconnecting links         |
| `resyncIntervalMs`    | 3000      | Guest `sync` repeat while unsynced  |
| `maxStateChars`       | 1,000,000 | Per-channel state cap               |

**Constraint:** failover budget (3000 + 700 + 2 x 1500 + 10000 = 16.7 s) must stay below `commandTtlMs`.

## Roster

| Key                             | Default       |
| ------------------------------- | ------------- |
| `maxPlayers`                    | 32            |
| `maxNameLength` / `defaultName` | 32 / "Player" |
| `banLimit`                      | 100           |
| `departureGraceMs`              | 4000          |
| `pingTimeoutMs`                 | 2000 (d)      |
| `linkWaitMs`                    | 8000          |
| `joinRetryMs`                   | 3000          |
| `profileTtlMs`                  | 24 h          |

## Game

| Key                             | Default     |
| ------------------------------- | ----------- |
| `awayAfterMs`                   | 10000       |
| `minWakeMs` / `maxSettlePasses` | 50 / 8      |
| `maxSettingsChars`              | 10000       |
| `maxSlotPlayers`                | 200         |
| `maxNameChars`, `maxIdChars`    | 64, 64      |
| `maxPieceChars`                 | 10000       |
| `maxNotices`, `maxTimers`       | 50, 20      |
| `maxTimerMs`, `maxTimerIdChars` | 24 h, 64    |
| `localTtlMs`, `maxLocalChars`   | 24 h, 50000 |

Timer relations (for example, `probeTimeoutMs` against `ackTimeoutMs`) are documented in the `why` field of each descriptor. They are **not machine-checked**.
