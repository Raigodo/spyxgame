# Installation

Read to run the project locally, configure Firebase and deploy.

## Requirements

- **Node 22 or newer** (CI uses Node 24). Vitest and lint-staged require it.
- **pnpm 11** (`packageManager` in `package.json`).
- A **Firebase project** with Firestore enabled.
- Optional: a **Cloudflare Realtime** TURN key, for players behind strict NATs.

## 1. Firebase

1. Create a Firebase project and enable **Firestore**.
2. Add a web app and copy its config values.
3. Add **TTL policies** on the field `expiresAt` for these collection groups: `rooms`, `signaling-peers`, `messages`, `election-candidates`, `host`.

Without TTL policies everything still works, but abandoned rooms and signals pile up forever.

> The repository ships **no Firestore security rules**. Write your own before going public. See [Known issues](../reference/known-issues.md#identity-and-security).

## 2. Environment

Copy `.env.example` to `.env`.

| Variable                                   | Required | Purpose                                                                                 |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_FIREBASE_API_KEY`             | yes      | Firebase web config                                                                     |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`         | yes      | Firebase web config                                                                     |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID`          | yes      | Firebase web config                                                                     |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`      | yes      | Firebase web config                                                                     |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | yes      | Firebase web config                                                                     |
| `NEXT_PUBLIC_FIREBASE_APP_ID`              | yes      | Firebase web config                                                                     |
| `NEXT_PUBLIC_LOG_LEVEL`                    | no       | `debug`, `info`, `warn`, `error`. Default: `debug` in development, `warn` in production |
| `NEXT_PUBLIC_LOG_SCOPES`                   | no       | Per-scope levels, e.g. `bus:debug,link:warn`. See [Debugging](../guides/debugging.md)   |
| `TURN_KEY_ID`                              | no       | Cloudflare Realtime key id. **Server side only**, never prefix with `NEXT_PUBLIC_`      |
| `TURN_KEY_API_TOKEN`                       | no       | Cloudflare Realtime API token. Server side only                                         |

The Firebase client is created on first use, so importing code never needs the environment. A missing variable throws an error that names it.

## 3. Run

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000/room>. **Create a room**, then open the same URL in a second tab (or another browser) to join it.

Restart the dev server after changing `NEXT_PUBLIC_*` variables.

## TURN (optional)

`/api/turn` (`src/app/api/turn/route.ts`) asks Cloudflare for short-lived relay credentials. The key stays on the server. Any failure, or a missing key, means the client falls back to Google STUN only. Credentials live 24 hours, and are fetched once per join.

## Scripts

| Command                                | Does                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| `pnpm dev`, `pnpm build`, `pnpm start` | Development server, production build, production server |
| `pnpm check`                           | `eslint . --quiet`, `tsc --noEmit`, `vitest run`        |
| `pnpm test`, `pnpm test:watch`         | Vitest (`src/**/*.test.ts`, Node environment)           |
| `pnpm format`, `pnpm format:check`     | Prettier                                                |

A Husky pre-commit hook runs `lint-staged` (Prettier and ESLint on staged files) and then `pnpm run check`. `pnpm check` must pass before a commit.

## Deployment

Deployment is a GitHub Actions workflow (`.github/workflows/deploy.yml`) that runs on every push to `main`:

1. `check`: install with the frozen lockfile and run `pnpm check`.
2. `deploy` (needs `check`): `npx vercel deploy --prod`.

Required repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. `vercel.json` disables Vercel's own Git deployments, so the workflow is the only way to ship.

Set the same environment variables in the Vercel project.
