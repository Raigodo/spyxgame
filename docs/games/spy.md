# Spy (game spec)

Id `spy`. Modes `["free-for-all"]`. `minPlayers` 3, `maxPlayers` 12. Late joiners spectate.
All talking happens in an external voice call. The game only coordinates who does what, when.

## Principles

- All meaningful state lives in the game's `state`. Reducers are pure functions of (state, payload, sender).
- Randomness: the host's `begin` carries one integer `seed`. Word, spy, speaking order and every tie-break derive from it with a seeded PRNG (`spy-rules.ts`), so failover stays deterministic.
- Secrecy is trust-based. `word` and `spyId` replicate to every peer (needed for failover). The UI hides them.
- Local notes are never replicated (presentation layer only).
- Away players (replicated slot.away) are skipped and not waited for. settle in spy-rules.ts does all skipping and phase resolution.

## Config

`{ wordsPerPlayer: 1..10 (default 3), minWords: default 5 }`

## State

`phase`, `words: {id, ownerId, text}[]`, `nextWordId`, `word?`, `spyId?`, `order` (all participants, shuffled), `turn`, `circle`, `decisions`, `votes`, `accusedId?`, `claim?: {from, votes}`, `rngSeed`, `result?: {winner, reason}`.

## Phases

1. **collecting**: players add or remove their own words (visible to all). The host can `begin` with at least `minWords` words. A speaker who is away is skipped. In deciding, voting and claim votes a phase resolves once every player who is not away has answered (at least one answer needed).
2. **talking**: circle _n_, speaker is `order[turn]`. After the last speaker go to deciding.
3. **deciding**: everyone picks `vote` or `continue`. More than 50% `vote` goes to voting. Otherwise next circle (same order).
4. **voting**: everyone votes for one other player (the spy too). Plurality wins, ties broken by seed.
   - Accused is not the spy: spy wins (`wrong-accusation`).
   - Accused is the spy: lastChance.
5. **lastChance**: the spy may `claimWord` or `giveUp` (players win, `spy-caught`).
6. **ended**: reveal word, spy, winner, reason. The host's `endGame` returns everyone to the lobby.

## Claim ("I know the word")

The spy says the word in the call and presses a button, in talking, deciding, voting or lastChance.
Non-spies vote Correct or Wrong. Resolves when all non-spies voted, or on host `forceAdvance` with the votes cast.
More Correct than half of the votes cast: spy wins (`spy-guessed`, or `spy-caught-guessed` if already accused). Fewer: players win (`spy-failed-guess`). Exact tie: seeded coin. No votes cast: players win.
While a claim is pending, `endTurn`, `skipTurn`, `decide` and `vote` are rejected with `claim-pending`.

## Commands

| Command        | Who                 | When                                  | Effect                                               |
| -------------- | ------------------- | ------------------------------------- | ---------------------------------------------------- |
| `addWord`      | participant         | collecting                            | 1-40 chars, per-player cap, no case-insensitive dup  |
| `removeWord`   | word owner          | collecting                            | remove                                               |
| `begin`        | host                | collecting                            | derive word, spy, order from seed; go to talking     |
| `endTurn`      | current speaker     | talking                               | advance                                              |
| `skipTurn`     | host                | talking                               | advance for an absent speaker                        |
| `decide`       | participant         | deciding                              | `vote` or `continue`                                 |
| `vote`         | participant         | voting                                | no self-vote                                         |
| `claimWord`    | spy                 | talking, deciding, voting, lastChance | opens the claim vote                                 |
| `claimVote`    | non-spy participant | claim pending                         | Correct or Wrong                                     |
| `giveUp`       | spy                 | lastChance                            | players win                                          |
| `forceAdvance` | host                | deciding, voting, claim, lastChance   | resolve with votes cast; lastChance counts as giveUp |

`endTurn` and `skipTurn` are separate because a game reducer cannot tell who the host is; `allow: "host"` does it.
No ephemeral events.

## Local notes (presentation only)

Free-text pad per game, per-player marker (`?` / suspect / safe) plus a short note, collapsible panel, show/hide word pool. Persisted locally by room, round and playerId.

## Known limits

- Players who are away no longer block the game. forceAdvance is needed only when everyone is away or when the spy is away in lastChance.
- Below 3 present players the game pauses; the host can continue anyway or end it.
- If the spy leaves mid-game, the host ends it with endGame.
- Spectators see neither word nor spy until the game ends.
