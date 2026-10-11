# Glossary

- **Member / membership**: a peer's document in Firestore `signaling-peers`. Says nothing about liveness.
- **Peer** (`peerId`, ULID): one joined page load. Fresh per join, never reused. Used for links, elections and verified senders.
- **Player** (`playerId`): the durable identity of a person across refreshes and reconnects. Lives in profile metadata.
- **Link**: the WebRTC data channel to one peer (`RtcPeerRegistry` entry), status connecting / active / reconnecting.
- **Signaling session** (`SignalingSession`): the Firestore side of a join: membership, signal inboxes, host election.
- **Player session** (`PlayerSession`): the roster and star relay on top of the RTC links.
- **Join / leave**: client-level (`MultiplayerClient`, `PlayerSession`). `joinRoom/leaveRoom` belong to `SignalingSession` and `WebRtcService` and mean the same at their level.
- **Superseded**: this tab lost duplicate-tab arbitration (`onSuperseded`, status `superseded`). **Kicked**: removed by the host. **Banned**: kicked, and the playerId cannot rejoin this room.
- **Ghost**: a departed player's local "reconnecting" row, kept for the grace period. Also a dead duplicate tab that arbitration removes.
- **Host seat**: the host document naming a peer. **Reclaim**: a refreshed host taking the seat back with a new peer id.
- **Confirmed candidate**: a guest that wrote its candidacy after the collection window; only these are elected.
- **Naming rule**: `use*` is for React hooks only. Non-hook accessors are `get*`.
