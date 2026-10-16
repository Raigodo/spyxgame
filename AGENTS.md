# Working in this repo

Read [docs/README.md](./docs/README.md) first, then `docs/overview.md`. Read `docs/invariants.md` before touching `src/shared`.

## Rules that always apply

- Layers, bottom to top: kernel, infrastructure, application, presentation. Dependencies point down only. No React hooks below presentation.
- Everything touching the outside world is an injected port. See `docs/conventions.md`.
- Network input is untrusted and validated. Only the host-verified sender is trusted.
- `playerId` is durable, `peerId` is fresh per join. Reducers are pure.
- `pnpm check` (lint, types, tests) must pass before a commit.

## Maintainer's preferences

- Compact replies. Say which file changes and why.
- Give precise change instructions (file, exact old code, exact new code). Give a whole file when it is new, heavily changed, or already patched several times, or when asked.
- Ask only when a decision matters: one specific question with a recommended default, answerable in one word.
- The code cannot be run by the agent. Say what is unverified and give a short test checklist.
- Do not write tests until asked, but keep things testable.
- Do not add features beyond the request. Delete dead code instead of keeping it.

## Keeping docs honest

When you change behavior that a doc describes, update that doc in the same change. A new timer needs its `docs/timers.md` row. Follow the rules at the top of `docs/README.md`.
