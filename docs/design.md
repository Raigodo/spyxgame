# Design: browser board-game framework (P2P over WebRTC)

Goal: any board game is one typed definition (`defineGame`) plus a page. Networking, lobby, chat and recovery are never touched per game.

Priorities, in order: (1) resilience, (2) readable code that is cheap to change, (3) testable and modular, (4) minimal Firestore usage, (5) minimal token use in AI chats.

If a doc and the code disagree on a detail, the code wins. If they disagree on intent, ask.

## Topology

- Players talk peer to peer over WebRTC data channels (ordered, reliable, label "data").
- Star: the host connects to every guest. Guests talk only to the host, which relays broadcasts and direct messages and stamps the verified sender.
- Firestore is only signaling: membership, per-peer signal inboxes (offer, answer, ICE batches), the host document, election candidates.
- No heartbeats, no polling. Membership has no liveness; a peer is removed only when someone suspects it, through one pipeline (`PeerRemover`).
- The host is elected, not fixed. State is host-owned but replicated, so any guest can take over.

## Layers

kernel -> infrastructure (signaling, webrtc, player) -> application (messaging, presence, lobby, chat, game, room) -> presentation (React). Dependencies point down only. Details: [docs/layers.md](docs/layers.md).

## Where things are

| Need                                                   | Read                                         |
| ------------------------------------------------------ | -------------------------------------------- |
| What each module does                                  | [docs/layers.md](docs/layers.md)             |
| How state and commands replicate                       | [docs/messaging.md](docs/messaging.md)       |
| What must never break, and why                         | [docs/invariants.md](docs/invariants.md)     |
| Every timer and what it protects                       | [docs/timers.md](docs/timers.md)             |
| Why it is built this way                               | [docs/decisions.md](docs/decisions.md)       |
| Known gaps                                             | [docs/known-issues.md](docs/known-issues.md) |
| Terms (peer, player, member, link)                     | [docs/glossary.md](docs/glossary.md)         |
| Rules for writing code, adding a game, port or message | [conventions.md](conventions.md)             |
