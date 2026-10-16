# Docs

Start here. This folder should give a newcomer (human or agent) the full picture of the project. If it does not, fix the docs.

## Reading order

1. [overview.md](./overview.md): goal, priorities, topology, layers, where code lives.
2. Then by task:

| You want to | Read |
| --- | --- |
| Change anything under `src/shared` | [invariants.md](./invariants.md), then the matching concept doc |
| Understand host loss, election, refresh, links | [concepts/failover.md](./concepts/failover.md) |
| Touch the bus, channels, commands, recovery | [concepts/messaging.md](./concepts/messaging.md) |
| Touch roster, ghosts, duplicates, kick/ban | [concepts/presence.md](./concepts/presence.md) |
| Add or change a game, or the game framework | [concepts/games.md](./concepts/games.md), [conventions.md](./conventions.md) |
| Write or debug tests | [concepts/testing.md](./concepts/testing.md) |
| Change a timer | [timers.md](./timers.md) (a test enforces it) |
| Ask "why is it built this way?" | [decisions.md](./decisions.md) |
| See what is broken, missing, or next | [known-issues.md](./known-issues.md) |
| Decode a term (peer, player, slot, ghost) | [glossary.md](./glossary.md) |

## Files

- `overview.md`: the whole system in one page.
- `concepts/`: how each subsystem works. Only what the code does not show by itself.
- `invariants.md`: rules that must never break, and why.
- `conventions.md`: how to write code here, and how to add a game, port, timer or message.
- `decisions.md`: deliberate choices, each with the rejected alternative.
- `known-issues.md`: gaps, plus status and next steps.
- `timers.md`: every timer, what it protects, what a wrong value costs.
- `glossary.md`, `games/<id>.md` (one spec per game).

## Rules for these docs

- The code wins on detail. These docs win on intent. If they disagree on intent, ask.
- Document only: behavior spread over several files, deliberate choices with a rejected alternative, rules whose violation fails silently, and known gaps. Do not document what a good name already says (class lists, method lists, wire kinds).
- If a decision is reversed, edit its entry in place. Do not append.
- A file stays under about 150 lines. Split by subsystem if it grows.
- Every doc starts with one sentence saying when to read it.
- Tests read `timers.md` and some tables by row prefix (`` | `name` ``). Keep those table formats.