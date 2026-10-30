# Roster

Read before changing who may be in the room, how names and duplicate tabs work, or moderation. The roster is one replicated state channel plus the host-side behavior around it.

## What it exposes

```ts
roster.state.players; // Store<readonly Player[]>   (join order, ghosts included)
roster.state.me; // Store<Player | undefined>   (undefined until admitted)
roster.state.host; // Store<Player | undefined>
roster.state.bans; // Store<ReadonlySet<PlayerId>>
roster.events.joined; // Listenable<Player>
roster.events.rejoined; // Listenable<Player>
roster.events.left; // Listenable<{ player, reason: "expired" | "removed" }>
roster.events.refused; // Listenable<"banned" | "full">
roster.actions.rename(name); // Result<void, "invalid" | "unknown-player" | BusFailure>
roster.actions.kick(id) / ban(id) / unban(id) / handOff(id); // host only
```

`Player`: `id`, `name`, `peerId?` (absent for a ghost), `presence` (`self | online | connecting | reconnecting`), `isHost`, `joinedAt`. A ghost has presence `reconnecting`.

Moderation intents return `Result<void, TargetReject>`: `not-host`, `not-ready` (bus not synced), `unknown-player`, `cannot-target-self`. `handOff` may also fail with the transport's `HandOffReject` (`not-host`, `target-unavailable`, `host-changed`).

## State

One channel, keyed by `playerId` (durable), not by peer:

```
entries: { [playerId]: { name, joinedAt, peerId?, link, goneAt? } }
bans:    PlayerId[]   (newest kept, at most banLimit)
```

- `peerId` is the player's current peer, always the verified sender, never from a payload. It is absent for a **ghost**.
- `link` is `connecting`, `active` or `reconnecting`. The host writes it from the transport's member and link state; its own row is always `active`.
- **Ghost:** a player whose peer left membership. The entry stays (`link: reconnecting`, `goneAt` = host time) so a refresh rejoins as the same player; once `departureGraceMs` has passed a `sync` removes it and a `left` event (`expired`) fires.

Commands: `join`, `rename` (anyone, for themselves); `sync { links }`, `remove`, `ban`, `unban` (host only).

## Joining

1. A guest sends `join { name }` on the roster channel and **repeats until its row appears** (`joinRetryMs`).
2. The join reducer fails with `banned` (player is in `bans`), `full` (`maxPlayers` entries) or `taken` (another peer holds the entry and its link is `active`, see Duplicate tabs).
3. `banned` / `full` stop the retries and fire `events.refused`; the room ends (`Room.ended`: `kicked` for banned, `full`).
4. A returning `playerId` whose holder is a ghost or not active is a rejoin: the entry gets the new `peerId` and keeps its stored `name` and `joinedAt`.

The join name is `pickName`: explicit nickname, else the remembered one, else `defaultName`, trimmed and cut to `maxNameLength`. `rename` saves it to the profile storage (key prefix `player-profile:`, `profileTtlMs`).

## Host-side upkeep

`HostFlow` runs only while this peer is host and `bus.sync` is `ready`. One idempotent `reconcile`, re-run on role, members, links, sync and roster changes: `sync` (one link key per member peer; a peer that left membership becomes a ghost, then expires), `join` for the host's own row, a clock wake-up at the next ghost expiry, duplicate-tab arbitration, and `enforceBans`. The same code runs on a new host after failover, from the replicated state alone.

## Duplicate tabs

Two tabs with the same `playerId` (a copy of the URL, or a restored session) must not both play.

1. A second member peer joins with the same `playerId` as the entry's holder. Its `join` fails with `taken` while the holder's link is `active`, and it keeps retrying.
2. `planDuplicates` makes a challenge. The host waits until the holder's link is `active` (at most `linkWaitMs`), then sends `ping` on the `roster-events` channel and waits `pingTimeoutMs`. If the holder is the host itself, it counts as answered.
3. A `pong` (from the holder, matching nonce) means the holder is alive: the newcomers are dropped with `superseded`.
4. No pong: the holder is dropped with `superseded`, and the newcomer's repeated join then takes over.
5. A dropped tab gets `transport.dropped("superseded")`, so `Room.ended` is `superseded`.

Guests answer a `ping` only when it comes from the current host. The decision is pure: `planDuplicates` and `resolveChallenge` in `duplicates.ts`.

## Moderation

`Moderation` (host only; `not-host` / `not-ready` gates):

- **Kick:** `remove` command, then `transport.drop(peer, "kicked")` on the peer that held the entry. The player can rejoin.
- **Ban:** `ban` command (removes the entry, adds to `bans`) and the same drop. `HostFlow.enforceBans` drops any member peer whose playerId is banned, on every reconcile, including after failover.
- **Unban:** `unban` command (`unknown-player` if not banned).
- **Hand-off:** `transport.handOff(peer)` for the target's live peer; `unknown-player` if it is a ghost.

Bans are keyed by `playerId`, and a player's id is per tab. A banned player who opens a new tab gets a new id. See [Known issues](../reference/known-issues.md#identity-and-security).

## Files

`model.ts` schemas, types, public API; `rules.ts` pure reducers and projections (`applyJoin`, `applySync`, `nextGhostExpiry`, `entriesToPlayers`); `duplicates.ts` `planDuplicates`, `resolveChallenge`; `changes.ts` `diffPlayers` (joined / rejoined / left); `state.ts` channels and thin reducers; `view.ts` derived stores and change events; `host-flow.ts`, `guest-flow.ts`, `moderation.ts`; `profile-store.ts`, `names.ts` (channel ids, event kinds), `config.ts`, `create-roster.ts` (wiring). Settings: [Configuration](../guides/configuration.md#roster).
