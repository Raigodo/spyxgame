# Games framework

Read when adding a game or changing `src/shared/application/game`. How to add one step by step: [conventions.md](../conventions.md#adding-things).

## Two layers of state

- **Room state** (`room` channel): `phase` (lobby or in-game), lobby config (mode, teams), `round`, the active game, and `lastGame`. Host-only commands change it. `endGame` bumps `round` and stores `lastGame` so the lobby can offer the same game and config again.
- **Game slot** (`game:<id>` channel): everything about a running game. The host runtime creates the slot when the room is in-game and the slot's round differs from the room's, and clears it otherwise.

## A game definition

`defineGame({ id, modes, minPlayers, maxPlayers, validateConfig, validateState, initialState, commands, ... })`. Optional parts: `events`, `onLateJoin`, `presence`, `timers`, `privateState`, `version` and `migrate`. Everything from the network goes through the game's own validators. Reducers are pure functions of `(state, payload, config, context, away, privateState view)`, so a newly promoted host can keep the game running from replicated state alone.

Command wrapper order (`createRuntime`): authorize (`allow`, and the pause gate) then your `reduce`, then effects, then private pieces, then commit. A reducer returns `{ ok, state, effects?, privateState? }` or `{ ok: false, reason }`. Reasons are shown to players, so give them readable text in the page.

## Slot, in short

`participants`, `spectators` (late joiners and dropped players), `away`, `paused`, `forced`, `endRequested`, `notices`, `timers`, `privateRev`, `names` (playerId to nickname, copied from the roster so a departed player keeps a name), `teams`, `stateVersion`. Missing fields default when a slot from an older build arrives. A present but malformed field rejects the slot.

## Away, pause, rejoin

- The host runtime derives presence from the roster and writes it into the slot. A participant with no live roster row for `awayAfterMs` (10s, per-game override) is marked **away**. A "reconnecting" ghost counts as absent. The timers only debounce: after a failover the new host re-derives from the replicated slot.
- On return, `rejoin` decides: `"restore"` (default, keeps the place), `"spectate"`, or a function per player.
- `presence.minPresent` with `belowMin`: `"continue"` (default), `"pause"` (the generic gate rejects non-host commands with `paused`, resumes by itself), or `"end"`. Present means not away. The host can `continueAnyway()`, which sets `forced` until the count recovers.
- Kick and ban drop the player to spectators immediately. If the host fails in that moment, the normal away path takes over after 10s.
- Reducers receive `away`, so quorums (everyone voted) can ignore absent players. `presence.onChange` runs in the same publish as the away change, so nobody sees one without the other.
- `onLateJoin` can admit a joiner, or take over an away player's seat (`replaces`, which works at `maxPlayers`).

## Effects, notices, timers

Reducers, timer handlers and `presence.onChange` (via `withEffects`) may return effects. They are plain data.

- `emit`: a **notice**, replicated and round-scoped (newest 50). Same validators as `events`. Read with `onNotice` or `getNotices`. Use this instead of diffing state in a page.
- `end`: sets `endRequested`. The host runtime ends the game once per round. Do not use it if the page must show a result screen.
- `startTimer` / `cancelTimer`: timers live in the slot with a deadline stamped from the host's clock. The host runtime arms one local `Clock.after` per timer, fires the handler and removes the timer in **one publish** (exactly once), re-arms after failover (overdue ones fire at once), and freezes timers while paused. Game logic never reads a clock: deadlines are display data (`getTimers`, `useCountdown`). A timeout in a page is the wrong tool.

## Local and private state

- **Local** (`defineLocalState`, `game.local(def)`): device only, never sent. Stored through the `KeyValueStore` port (localStorage with expiry), keyed by room, round and player. It survives a refresh, not a new device or round. Use for notes and UI memory.
- **Private** (`privateState`): per-player values only the owner sees. The slot holds only revisions. The host keeps all pieces in memory and sends each owner its own piece; guests offer their own back during recovery; `recover` rebuilds anything lost (make it a deterministic function of replicated state, for example derived from a seed). **The host can read every piece**: it is a browser. This protects against other guests and the wire, not a cheating host. Spy's `word` and `spyId` are still in public state and only hidden by the UI.

## Versioning

`version` is stamped into every slot. `migrate` upgrades older raw config or state before your validators see it. A slot from a **newer** build is rejected, so that guest stays syncing until it reloads.

## UI contract

`game.getPlayers()` (names, role, away), `getAway`, `isPaused`, `getNotices`, `getTimers`, `getPrivate`, `local(def)`, plus state, config, context, role, team. All are referentially stable until they change. Use `useGameValue(game, () => game.getX())`. Never resolve names from the live roster: it forgets departed players.
