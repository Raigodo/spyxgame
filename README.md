# Spyxgame

Browser board-game framework. Players talk peer to peer over WebRTC, and Firestore is used only for signaling. A game is one typed definition plus a page.

**Documentation:** start at [docs/README.md](./docs/README.md). Working agreements for contributors and agents: [AGENTS.md](./AGENTS.md).

## Setup

1. Copy `.env.example` to `.env` and fill in the Firebase values. Optionally set `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` (server-side only) for relay servers.
2. Enable Firestore. Optionally add TTL policies on `expiresAt` for the `rooms`, `signaling-peers`, `messages`, `election-candidates` and `host` collection groups.
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

- Set `NEXT_PUBLIC_LOG_LEVEL` and `NEXT_PUBLIC_LOG_SCOPES` (for example `bus:debug,webrtc:warn`), then restart the dev server.
- In a development build, `window.__room()` in the browser console returns a snapshot of the bus, presence, election and links.