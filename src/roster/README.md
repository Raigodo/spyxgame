# roster

Who is in the room, and in what state. One replicated channel (`roster`), keyed by `playerId`.
Entry: name, joinedAt, `peerId` (the verified sender, never from a payload), link, `goneAt`.
Bans live in the same state. Ghost = an entry with no `peerId` and a `goneAt`.

## Files
- `model.ts` public types and network schemas. `config.ts` knobs. `names.ts` channel ids.
- `rules.ts` pure reducers and projections (join, rename, sync, remove, ban, unban, players).
- `duplicates.ts` pure duplicate-tab detection and verdict. `changes.ts` pure list diff.
- `state.ts` registers the channels, reducers are thin wrappers over `rules.ts`.
- `view.ts` derived stores (stable references) and joined / rejoined / left events.
- `host-flow.ts` host only: `sync`, own row, ghost-expiry wake-up, ping/pong arbitration.
- `guest-flow.ts` guest only: repeat `join` until admitted, answer pings, report refusal.
- `moderation.ts` kick, ban, unban, handOff. `profile-store.ts` remembered nickname.
- `create-roster.ts` wires everything on one scope. `fakes.ts` test harness.

## Rules
- Only the host writes `sync`. Entries of non-member peers become ghosts and expire after
  `departureGraceMs` of host time. A refresh is one row: reconnecting, then online.
- A join from a new peer for a held entry is `taken` while the holder's link is active; the host
  pings the holder: pong drops the newcomer, no pong drops the holder, the newcomer's repeated
  join then takes over.
- Guests repeat `join` every `joinRetryMs` until their row shows up. `banned` / `full` stop it.
- No heartbeats, no polling: everything reacts to membership, link and state changes.

## Changing a behavior
Decision change: `rules.ts` or `duplicates.ts`. Timing: `config.ts`. New command: `model.ts`,
`rules.ts`, one entry in `state.ts`.
