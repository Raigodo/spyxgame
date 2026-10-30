# Documentation

Start here. These docs describe the app backend: how it is built, why, and how to use it.

## Reading paths

| You want to | Read |
| --- | --- |
| Run the project | [Installation](./getting-started/installation.md) |
| Find your way around the code | [Project structure](./getting-started/project-structure.md) |
| Understand the whole system in one page | [Architecture overview](./architecture/overview.md) |
| Build a game | [Creating a game](./guides/creating-a-game.md), then [Game framework](./architecture/game-framework.md) |
| Build UI on top of the backend | [UI](./architecture/ui.md), [Using the Room API](./guides/using-the-room-api.md) |
| Change networking, host loss or election | [Transport](./architecture/transport.md), [Invariants](./reference/invariants.md) |
| Change replicated state or commands | [Bus](./architecture/bus.md) |
| Change players, ghosts, kick or ban | [Roster](./architecture/roster.md) |
| Change a timer or a limit | [Configuration](./guides/configuration.md) |
| Write or debug a test | [Testing](./guides/testing.md) |
| Ask "why is it built this way?" | [Decisions](./reference/decisions.md) |
| See what is broken or missing | [Known issues](./reference/known-issues.md) |
| Decode a term | [Glossary](./reference/glossary.md) |

## Contents

### Getting started
- [Installation](./getting-started/installation.md): requirements, Firebase, environment, TURN, scripts, deployment.
- [Project structure](./getting-started/project-structure.md): folders, layers, how a feature folder looks.

### Architecture
- [Overview](./architecture/overview.md): goal, topology, three flows end to end.
- [Kernel](./architecture/kernel.md): stores, scopes, results, schemas, config, ports.
- [Transport](./architecture/transport.md): signaling, links, relay, election, reclaim.
- [Bus](./architecture/bus.md): channels, commands, recovery, private pieces, host time.
- [Roster](./architecture/roster.md): players, ghosts, duplicate tabs, kick and ban.
- [Game framework](./architecture/game-framework.md): slot, play gate, host loop, client API.
- [Room](./architecture/room.md): `joinRoom`, the `Room` object, teardown.
- [UI](./architecture/ui.md): shell, header slot, toasts, dialogs, game pages.

### Guides
- [Creating a game](./guides/creating-a-game.md)
- [Using the Room API](./guides/using-the-room-api.md)
- [Configuration](./guides/configuration.md)
- [Testing](./guides/testing.md)
- [Debugging](./guides/debugging.md)

### Reference
- [Invariants](./reference/invariants.md): rules that must never break.
- [Conventions](./reference/conventions.md): how to write code here.
- [Glossary](./reference/glossary.md)
- [Decisions](./reference/decisions.md): choices and rejected alternatives.
- [Known issues](./reference/known-issues.md)

## Rules for these docs

- The code wins on detail. These docs win on intent. If they disagree on intent, ask.
- Every page starts with one sentence saying when to read it.
- Document what is spread over several files, deliberate choices, rules whose violation fails silently, and known gaps. Do not repeat what a good name already says.
- When behavior changes, update the page that describes it in the same change.
- If a decision is reversed, edit its entry in [Decisions](./reference/decisions.md). Do not append.
- Keep a page under about 150 lines. Split by subsystem if it grows.
- Numbers in the docs mirror `config.ts` files. If you change a default, change it in [Configuration](./guides/configuration.md) too.
