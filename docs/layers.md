# Layers

Bottom to top. No React hooks below presentation.

**kernel**: Emitter, Store, Clock (`after`/`every` return cancel functions), IdGenerator (ULID), Logger, KeyValueStore, PageLifecycle, Countdown, shortId, guards, structurallyEqual, throttled warnings, config (one typed object, one section per layer).

**infrastructure/signaling**

- Ports: RoomMembershipPort, SignalInboxPort, HostElectionPort. Firestore adapters stamp `expiresAt` for TTL.
- SignalingSession: join/leave, peer tracking, mailbox, ack tracker, ack veto. Signal payloads are opaque: `sendSignal(peerId, payload, strategy)`.
- PeerRemover: the only place another peer is deleted from membership.
- HostElectionService: host document, `claimHost`, `transferHost`, first election.
- DeadHostElection: suspicion, collection window, confirm window, turns, atomic claim.
- Pure: election-order, peer-diff.

**infrastructure/webrtc**

- Ports: RtcConnectionProvider, RtcPeerConnectionPort, RtcDataChannelPort; browser adapters.
- WebRtcService: join/leave shell, host-change sequence, handoff.
- RtcHostRole, HostReclaimController, RtcSignalRouter, RtcPeerRegistry, RtcPeerLinkFactory, RtcLinkNegotiator (one link: offer/answer/ICE), ActiveRtcConnection, RtcReconnectionManager (offer watches, reconnect), IceBatcher, LinkProbe, ChunkedMessenger.
- Pure: chunking, link-policy, rtc-signal (shape and parser), link-probe rules.

**infrastructure/player**: PlayerSession (star relay, roster, verified-sender stamping), PlayerDirectory, HostClaimStore (refresh hint), PlayerProfileStore (nickname), envelope-parser, roster-diff.

**application/messaging**: RoomBus (routing, status, queue flushing; wire kinds dispatch through a typed handler table), StateChannel, EventChannel, BusRecovery, CommandQueue, wire parsing, bus-rules, transport adapter over PlayerSession.

**application/presence**: PlayerReconnectionCoordinator (event dispatcher, kick, ban, hello) over PresenceBook (statuses), DuplicateView (every-peer hiding), DuplicateArbiter (host-only ping/pong). PlayerPresenceService (roster read-model), DepartureGhosts. Pure: duplicate-rules, presence-history, presence-bans. Channels: `presence` (events), `presence:history`, `presence:bans`.

**application/lobby**: LobbyModule (mode as data), lobby-rules, LobbyPlayerView.

**application/chat, game**: ChatService; defineGame, GameRuntime, GameHandle, GameHostRuntime.

**application/room**: RoomStateService, MultiplayerClient (facade), createMultiplayerClient (composition root). Client helpers: HostSeatKeeper, ClientGameBackend, RosterView, ClientLifecycle.

**presentation**: RoomProvider, hooks (`useClientValue` over `useSyncExternalStore`), RoomNavigator, ChatPanel, pages, game registry. Pages are the regression boundary.

**testing** (`src/shared/testing`): RoomHarness, fake ports, fake RTC, FakeClock, milestones.
