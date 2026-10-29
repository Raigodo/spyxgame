# Spyxgame

A browser board-game framework. Players talk **peer to peer over WebRTC**; Firestore is used **only for signaling**. A game is one typed definition plus a page: networking, rooms, presence, host failover and state replication are never touched per game.

> **Status:** the backend (transport, bus, roster, game framework, room) is built and has two games (`demo-tap`, `spy`). The lobby (ready/teams), chat and a real UI are not built yet. The pages in `src/ui` are minimal placeholders.

## What you get

- **Rooms without a server.** One browser is the host, the others are guests. If the host dies, a new host is elected and the game continues from replicated state.
- **Replicated, versioned state.** Every shared value is a bus channel with `(epoch, rev)` versions and exactly-once commands.
- **A small game API.** `defineGame` with schemas and pure reducers. Late joiners, pause, away players, timers, notices and private pieces are framework features.
- **Typed, reactive client.** Everything the UI reads is a `Store<T>`; every action returns a `Result` and never throws for expected failures.
- **Testable by construction.** Everything touching the outside world is an injected port, so whole multi-peer scenarios run in memory.

## Quick start

```bash
cp .env.example .env     # fill in the Firebase values
pnpm install
pnpm dev
```

Open <http://localhost:3000/room>, create a room, then open the same room in a second tab.

Full setup (Firebase, TTL policies, TURN, deployment): [Installation](./docs/getting-started/installation.md).

## A taste of the API

```ts
import { getRoomDeps } from "@/compose";
import { joinRoom } from "@/room";
import { as, type RoomId } from "@/kernel";

const result = await joinRoom(getRoomDeps(), { roomId: as<RoomId>("abc123") });
if (!result.ok) throw new Error(result.reason); // "unavailable"

const { room } = result.value;
room.roster.state.players.subscribe((players) => console.log(players));

const started = await room.game.actions.start(demoTap, { goal: 20 }); // host only
if (!started.ok) console.log(started.reason); // e.g. "not-host"
```

Using it from React: [Using the Room API](./docs/guides/using-the-room-api.md).

## Documentation

Start at the [documentation index](./docs/README.md).

| Section | What is in it |
| --- | --- |
| [Getting started](./docs/getting-started/installation.md) | Install, configure, run, deploy, project layout |
| [Architecture](./docs/architecture/overview.md) | How the system works, layer by layer |
| [Guides](./docs/guides/creating-a-game.md) | Creating a game, using the Room API, configuration, testing, debugging |
| [Reference](./docs/reference/invariants.md) | Invariants, conventions, glossary, decisions, known issues |

Working agreements for contributors and agents: [AGENTS.md](./AGENTS.md).

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development, production build, production server |
| `pnpm check` | ESLint, `tsc --noEmit` and the tests. Also runs on pre-commit |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm format` / `pnpm format:check` | Prettier |

## Stack

Next.js (app router), React 19, TypeScript (strict), Firebase Firestore, WebRTC, Tailwind 4, Vitest, pnpm. Deployed on Vercel.

## License

MIT, see [LICENSE](./LICENSE).
