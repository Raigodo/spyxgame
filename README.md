# Spyxgame

Browser board-game framework. Players talk peer to peer over WebRTC, and Firestore is used only for signaling (room membership, offers and answers, host election). Any game is one typed definition plus a page.

## Docs

- [design.md](./design.md): architecture overview and a map of the reference docs.
- [conventions.md](./conventions.md): rules for writing code, and how to add a game, port, timer or message.
- [docs/](./docs): layers, messaging model, invariants, timers, decision log, known issues, glossary.

Read `design.md` before changing anything under `src/shared`.

## Setup

1. Copy `.env.example` to `.env` and fill in the Firebase values.
2. Enable Firestore in your Firebase project. Optionally add TTL policies on `expiresAt` for the `rooms`, `signaling-peers`, `messages`, `election-candidates` and `host` collection groups (see [docs/decisions.md](./docs/decisions.md), Firestore cost).
3. Install and run:

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000/room to create or join a room.

## Scripts

- `pnpm check`: lint, type-check and tests (also runs on pre-commit)
- `pnpm test` / `pnpm test:watch`: Vitest
- `pnpm build` / `pnpm start`: production build and server
- `pnpm format`: Prettier

## Debugging

- Log levels: set `NEXT_PUBLIC_LOG_LEVEL` and `NEXT_PUBLIC_LOG_SCOPES` (for example `bus:debug,webrtc:warn`) in `.env`, then restart the dev server.
- In a development build, `window.__room()` in the browser console returns a snapshot of the bus, presence, election and links.

## Adding a game

See "Adding things" in [conventions.md](./conventions.md).