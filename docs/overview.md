# Overview

Read first. It describes the whole system and tells you which other doc to open.

**Goal:** a browser board-game framework. A game is one typed definition (`defineGame`) plus a page. Networking, lobby, chat, presence and recovery are never touched per game.

**Priorities, in order:** (1) resilience, (2) readable code that is cheap to change, (3) testable and modular, (4) minimal Firestore usage, (5) minimal token use in AI chats.

## Topology

- Players talk peer to peer over WebRTC data channels (ordered, reliable, label `data`).
- **Star:** the host connects to every guest. Guests talk only to the host, which relays broadcasts and direct messages and stamps the verified sender. Guest-to-guest links are never opened.
- **Firestore is signaling only:** room membership, per-peer signal inboxes (offer, answer, ICE batches), the host document, election candidates. No heartbeats, no polling.
- **The host is elected, not fixed.** All state is host-owned but replicated, so any guest can take over. Host loss is a normal event: see [failover](./concepts/failover.md).
- **ICE:** Google STUN, plus relay servers fetched from `/api/turn` (Cloudflare Realtime; the key stays server-side; any failure means STUN only).
- Stack: Next.js app router, React 19, Firebase Firestore, Tailwind, Vitest, pnpm. Deployed on Vercel.

## Layers

```
kernel -> infrastructure (signaling, webrtc, player)
       -> application (messaging, presence, lobby, chat, game, room)
       -> presentation (React)
```

- Dependencies point down only. No React hooks below presentation.
- Everything that touches the outside world is a **port** injected from above: `Clock`, `IdGenerator`, `Logger`, `KeyValueStore`, `PageLifecycle`, the Firestore ports, the RTC ports. That is what makes the whole stack testable with fakes.
- Ports live in `ports/`, real implementations in `adapters/`, fakes in `shared/testing`. The composition root is `createMultiplayerClient`.

## Code map

| Path                                   | What is there                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/shared/kernel`                    | Ports and tiny utilities: Emitter, Store, Clock, Logger, config (one section per layer). |
| `src/shared/infrastructure/signaling`  | Firestore membership, inboxes, host document, and the election.                          |
| `src/shared/infrastructure/webrtc`     | Links, host role, reconnection, probes, chunking.                                        |
| `src/shared/infrastructure/player`     | `PlayerSession`: roster and the star relay. Local profile and host-claim stores.         |
| `src/shared/application/messaging`     | `RoomBus`: state, command, event and private channels.                                   |
| `src/shared/application/presence`      | Who is here, ghosts, duplicate tabs, kick and ban.                                       |
| `src/shared/application/lobby`, `chat` | Lobby rules (mode and teams as data), room chat.                                         |
| `src/shared/application/game`          | `defineGame` and the host-side game runtime.                                             |
| `src/shared/application/room`          | `MultiplayerClient`: the one facade the UI talks to.                                     |
| `src/shared/presentation/room`         | Provider, hooks, game registry, navigator.                                               |
| `src/app`                              | Next routes: room entry, lobby, one page per game, `/api/turn`.                          |
| `src/demo-tap`, `src/spy`              | The games.                                                                               |
| `src/shared/testing`                   | `RoomHarness` and the fakes.                                                             |

## One command, end to end

1. A page calls `game.sendCommand(...)`. The client queues it on the bus, with a sequence number.
2. A guest sends it to the host over its link. The host runs it locally.
3. On the host, the game runtime checks `allow` and the pause gate, runs your pure reducer, applies effects and private pieces, and commits a new state version.
4. The host broadcasts the new state. Guests accept it only if it is newer and comes from the current host. The sender gets an ack with the verdict.
5. Hooks re-render from the client's stable getters.

## One host failure, end to end

A guest sees the host's link die, suspects it, waits a 3s window, removes the host, and the confirmed candidates claim the host document atomically. The winner links to everyone, asks guests for their copies of all state, adopts the newest, and publishes. About 5 to 8 seconds. Details: [concepts/failover.md](./concepts/failover.md).
