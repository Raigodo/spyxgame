# Roster

Read before changing who may be in the room, how names and duplicate tabs work, or moderation. The roster is one replicated state channel plus the host-side behavior around it.

## What it exposes

```ts
roster.state.players; // Store<readonly Player[]>   (includes ghosts, marked)
roster.state.me; // Store<Player | undefined>
roster.state.host; // Store<Player | undefined>
roster.state.bans; // Store<readonly Ban[]>
roster.events; // Listenable<joined | rejoined | left>
roster.actions.rename(name);
roster.actions.kick(playerId) / ban(playerId) / unban(playerId) / handOff(playerId); // host only
```

Moderation intents return `Result`, and fail with a reason like `not-host`, `unknown-player`, `self`.

## State

One channel, keyed by `playerId` (durable), not by peer:

```
entries: { [playerId]: { name, joinedAt, peerId?, link, goneAt? } }
bans:    { [playerId]: ... }
```

- `peerId` is the player's current peer. It is absent for a **ghost**.
- `link` is `connected` or `reconnecting`, derived from the transport's link state.
- **Ghost:** a player whose peer left. The entry stays (`goneAt` set) so a refresh rejoins as the same player; after `departureGraceMs` on host time it is removed and a `left` event fires.

Commands: `join`, `rename` (anyone, for themselves); `sync`, `remove`, `ban`, `unban` (host).

## Joining

1. A guest sends `join { name }` on the roster channel and **repeats until its row appears** (`joinRetryMs`).
2. The host accepts it only if the verified sender is bound to that player, the player is not banned (`refused: banned`) and the room is not full (`refused: full`, `maxPlayers`).
3. A `refused` verdict ends the room (`Room.ended`).
4. A returning `playerId` is a rejoin: the ghost entry gets the new `peerId`.

Names are trimmed, clamped to `maxNameLength`, and fall back to `defaultName`. The last used name is kept in the profile storage (`profileTtlMs`).

## Host-side upkeep

The host watches membership and links and issues `sync` commands so the roster follows reality: a peer whose link died becomes `reconnecting`, then a ghost, then is removed. The same code runs on a new host after failover, from the replicated state alone.

## Duplicate tabs

Two tabs with the same `playerId` (a copy of the URL, or a restored session) must not both play.

1. The host sees a second peer claiming a bound player.
2. It **pings the old peer** and waits `pingTimeoutMs`.
3. A pong means both tabs are alive: the newer one wins and the older gets `bye superseded` (`Room.ended: superseded`).
4. No pong means the old tab is dead: the new peer simply takes over.

The decision is pure: `planDuplicates` and `resolveChallenge`.

## Moderation

- **Kick:** `transport.drop(peer, "kicked")`; the player can rejoin.
- **Ban:** adds to `bans` (max `banLimit`) and kicks. `enforceBans` re-checks on every roster change, including after failover.
- **Hand-off:** transfers the host seat through `transport.handOff`.

Bans are keyed by `playerId`, and a player's id is per tab. A banned player who opens a new tab gets a new id. See [Known issues](../reference/known-issues.md#identity-and-security).

## Files

`model.ts` schemas and types, `rules.ts` pure decisions (`planDuplicates`, `resolveChallenge`, ghost expiry), `state.ts` channel spec and reducer, `host-flow.ts` upkeep, `guest-flow.ts` join retry, `moderation.ts`, `profile.ts`. Settings: [Configuration](../guides/configuration.md#roster).
