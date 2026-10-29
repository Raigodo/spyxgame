# Known issues

Read before relying on a behavior that sounds too good, or before going public.

## Identity and security

- **No Firestore security rules** are shipped. Anyone with the project config can read and write signaling data. Write rules before going public.
- **`playerId` is per tab** (sessionStorage), so a banned player gets a new id by opening a new tab. Bans are not durable identity bans.
- **Secrets in public state:** the spy game's word and `spyId` are in public state and hidden by the UI only. Move them to private pieces before real use.
- **`/api/turn` is public** (only a cross-site check). Add rate limiting before relying on it.

## Not built

- Lobby modes, chat, ready checks, teams, real UI. The present UI is a placeholder.
- Telemetry.

## Unverified

- The 5 to 8 s failover time is from the old code and has not been re-measured.
- Timer relations are described, not machine-checked.
- Documentation was written from reading the code, without running it.

## Behavior to know

- `dropped` fires only when a `bye` is received, not on a plain link close.
- Messages are limited to about 3 MB; larger ones are refused at the sender.
- Without TTL policies, Firestore collects abandoned rooms.
