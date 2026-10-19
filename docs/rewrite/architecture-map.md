# Architecture map (current)

Read to get the whole current codebase in one page before planning a change. It describes the code as it is today, before the redesign in [proposal.md](./proposal.md). Narrative docs: [overview.md](./overview.md).

## Slices today

| Slice        | Owns                                                 | Operators                                                                   | Outward events                                             |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| signaling    | membership, inboxes, host doc, candidates            | election (`DeadHostElection`, `election-order`), `PeerRemover`, ack tracker | peer joined/left, signal, host changed                     |
| webrtc       | link registry, host role, reconnect                  | link negotiator, probe, ICE batcher, chunking, reclaim                      | peer status, message, host changed                         |
| player       | directory (profiles), local profile and claim stores | `PlayerSession` (star relay, verified sender, roster broadcast)             | joined/updated/left, message                               |
| messaging    | state/event/private channels, command queue          | `RoomBus` (recovery, resync, status)                                        | status, channel changes                                    |
| presence     | book, duplicate view, ghosts, history, bans          | coordinator (dispatch), arbiter, service                                    | joined/rejoined/updated/left, superseded, kicked, farewell |
| lobby        | config (mode, teams)                                 | `LobbyModule`, view, rules                                                  | player events                                              |
| chat         | history                                              | `ChatService`, `RateLimiter`                                                | message                                                    |
| game         | slot per game                                        | `defineGame`, `createRuntime`, `GameHostRuntime`, timers, absence, effects  | slot changed, events                                       |
| room         | roster cache, lifecycle, handles                     | `MultiplayerClient` (about 50 members)                                      | about 15 callbacks                                         |
| presentation | provider, hooks, navigator                           | pages                                                                       | none                                                       |

Layers: kernel → infrastructure (signaling, webrtc, player) → application (messaging, presence, lobby, chat, game, room) → presentation (React). Games live in `src/spy` and `src/demo-tap`; fakes and the harness in `src/shared/testing`.

## Three flows

- **Command:** page → bus queue (seq) → link to host → host reducer (`allow`, pause gate, reduce, effects, private pieces) → commit → broadcast → ack → hooks re-render.
- **Join:** `performJoin` → fresh session stack (new peerId) → `assemble` → `wire` → `bus.start`.
- **Host change:** host doc changes → `handleHostChanged` → role switch → bus recovery (guests offer copies) → `reconcile` of games and presence.

## Player data, as it is

| Data                                  | Lives in                                     |
| ------------------------------------- | -------------------------------------------- |
| playerId, nickname                    | profile + `metadata.playerId`                |
| ready (`readyRound`), team (`teamId`) | profile metadata                             |
| connection status, returning          | host-published `status` events, plus `hello` |
| departed player's metadata            | `presence:history` channel                   |
| bans                                  | `presence:bans` channel                      |
| game secrets                          | private channel                              |
| notes                                 | local state (KV store)                       |
| nickname across visits                | profile cookie                               |
| host seat hint                        | sessionStorage host claim                    |

## Where to read next

| Task                       | Doc                                              |
| -------------------------- | ------------------------------------------------ |
| Why a decision was made    | [decisions.md](./decisions.md)                   |
| What must not break        | [invariants.md](./invariants.md)                 |
| Host loss and refresh      | [concepts/failover.md](./concepts/failover.md)   |
| Bus and commands           | [concepts/messaging.md](./concepts/messaging.md) |
| Roster, ghosts, duplicates | [concepts/presence.md](./concepts/presence.md)   |
| Games framework            | [concepts/games.md](./concepts/games.md)         |
| Problems found             | [review.md](./review.md)                         |
