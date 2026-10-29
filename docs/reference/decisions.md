# Decisions

Read to learn why the system is the way it is, before proposing to change it. Longer design history: `docs/rewrite/`.

| Decision                                                | Why                                           | Cost                                                         |
| ------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Star topology, not mesh                                 | Simple, one trusted sender stamp, fewer links | Host is a bottleneck; failover needed                        |
| Firestore for signaling only                            | Cheap, no server to run                       | No security rules shipped; TTL needed                        |
| No heartbeats, no polling                               | Minimal reads and writes                      | Death is inferred from links and silence, with grace periods |
| Replicated, versioned host state                        | Any guest can take over                       | Recovery protocol on promotion                               |
| `(epoch, rev)` versioning                               | Late messages from an old host lose           | One more concept                                             |
| Commands as the only mutation                           | One validation point, exactly-once            | Every change goes through a reducer                          |
| Pure reducers returning effects                         | Deterministic, host-independent timers        | Games describe, framework executes                           |
| Election by ULID order and staggered claim              | Deterministic, no extra messages              | Up to a few seconds of delay                                 |
| playerId durable, peerId fresh                          | Rejoin identity without stale-link bugs       | Needs duplicate-tab arbitration                              |
| Ports everywhere                                        | Tests need no browser                         | More files                                                   |
| Stores, Scope and Result instead of emitters and throws | Stable references, structured cleanup         | Custom kernel to maintain                                    |
| Rejected: lint rules for layers                         | Convention is enough for now                  | Relies on review                                             |
| Rejected: Telemetry port                                | Not needed yet                                | Only logs and `room.debug()`                                 |
