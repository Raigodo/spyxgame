# Presence: who is here

Read when touching the roster, reconnecting players, duplicate tabs, kick or ban.

## Building blocks

- `PlayerSession` (infrastructure) holds the raw roster: a profile per peer. The host aggregates profiles and broadcasts the roster.
- `PlayerPresenceService` (application) is the read model the UI and lobby use: roster rows plus connection status, `returning`, and ghosts.
- `PlayerReconnectionCoordinator` dispatches presence events over the `presence` event channel. Data lives in `PresenceBook`, the duplicate view in `DuplicateView`, host-only arbitration in `DuplicateArbiter`.

## Connection status

Only the host has a link to everyone, so only the host knows the status of each peer. It broadcasts a status map. Guests read their own link to the host directly and everyone else from that map. A guest the host has not acknowledged yet is `pending`: its ready and team controls are locked, and it says `hello` every 3s until the host answers.

## Returning players

A departed player's metadata is remembered under their durable `playerId` in the replicated `presence:history` channel (newest 50, a player replaces their own entry). Every peer reports departures, because after a host change only guests remember what the old host looked like. When the same `playerId` joins again, the host replays the metadata as `restore` and marks them `returning`. A newly promoted host restores itself once, within `linkWaitMs`, filling only keys its profile lacks.

## Ghosts

When a player leaves, everyone keeps a local "reconnecting" row for 4s (`departureGraceMs`), so a refresh does not flicker. Ghosts are local, not replicated. A player never sees a row for their own previous incarnation. The ghost is skipped when the player was removed on purpose, is us, or already has a live replacement.

## Duplicate tabs

The same `playerId` live twice:

1. The host announces the pair (`duplicate`): every peer hides the newcomer and shows the old row as reconnecting.
2. The host pings the old peer. A pong means it is alive, so the **newcomer is rejected** (it becomes `superseded`). No pong within 2s means a ghost, so the **old peer is removed** and the newcomer survives and is revealed.
3. If the old peer is the host's own tab, the newcomer is rejected without a ping.
4. After a promotion the host arbitrates existing duplicates, but waits for data-channel links first: a ping before the link is active is dropped and would make a live tab look dead.
5. A safety timeout (4s) reveals whoever is actually present if the resolution message was lost.

One pair per `playerId`. It cannot tell which of two live duplicates is older.

## Kick and ban

- **Kick:** the host broadcasts `farewell` (no ghost row anywhere), tells the player `kicked`, and removes them. They can rejoin through the invite link.
- **Ban:** the `playerId` goes into the replicated `presence:bans` channel (newest 100, per room). Banned players are hidden on every peer, never a ghost, and are kicked again if they rejoin.
- Both also drop the player from a running game at once (see [games](./games.md)).

## Order rules (silent failures if broken)

- A `pong` is handled before the host-only guards: it travels guest to host.
- A departed ghost's metadata goes to the surviving newcomer **before** the duplicate view fires the reveal, because the reveal decides `joined` versus `rejoined`.
- One visibility rule decides what the local player sees: their own row, minus hidden newcomers, minus banned players, minus their own previous incarnation.
