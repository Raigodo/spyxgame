# Debugging

Read when something does not connect, does not fail over, or does not sync.

## Logs

`ConsoleLogger` uses root scope `mp`. Levels: `NEXT_PUBLIC_LOG_LEVEL` (default `debug` in development, `warn` in production), per scope with `NEXT_PUBLIC_LOG_SCOPES`:

```
NEXT_PUBLIC_LOG_SCOPES=bus:debug,link:warn,election:debug
```

Restart the dev server after changing it. A scope matches by any segment of its name. Scopes in the code include `bus`, `game`, `election`, `link`, `relay`, `mailbox`, `probe`, `reclaim`, `reconnect`, `negotiator`, `registry`, `ice`, `chunks`, `acks`, `active`, `firestore`, `host`, `guest`, `moderation` and `events`.

Invalid network input is reported as a throttled warning with `{ from, kind }`; if you see it, a peer is sending something the schema rejects.

## Snapshot

`room.debug()` returns a snapshot of the current room: `roomId`, `playerId`, `self`, `role`, `host`, `sync`, `ended`, `members`, `links`, `players` and `bans`. Channel versions are not included. Log it from the console in a component that holds the room.

## Symptoms

| Symptom                       | Look at                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Stuck `syncing`               | Is there a host? (`debug().host`). Link to host `active`? Bus `sync` messages repeating? |
| Guest never appears in roster | `join` retry (`roster` logs). Banned or full? `ended` set?                               |
| No link, only STUN works      | ICE: `/api/turn` response, `iceFetchTimeoutMs`. Strict NAT needs TURN                    |
| Failover takes long           | Election logs: window, confirmations, position delay. Then bus recovery window           |
| Host refresh loses host       | Reclaim: `host-claim:<roomId>` in sessionStorage, pagehide stamp age                     |
| Same player twice             | Duplicate-tab ping/pong in roster logs                                                   |
| State rejected                | `invalid` or `too-large` on commit: schema or `maxStateChars`                            |

## Firestore

Read-only inspection in the console: `rooms/{roomId}/signaling-peers`, `host/current`, `election-candidates`. A stale peer there with no live tab is normal until TTL cleanup.

## Not available

There is no telemetry port and no global debug hook; `room.debug()` is the only built-in tool.
