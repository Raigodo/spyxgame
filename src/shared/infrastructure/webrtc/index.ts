import { ConsoleLogger, DEFAULT_CONFIG, SystemClock, UlidIdGenerator } from "@/shared/kernel";
import { createSignalingSession } from "../signaling";
import { BrowserRtcConnectionProvider } from "./adapters/browser/browser-rtc-connection-provider";
import { ChunkedMessenger, type ChunkedMessengerDeps } from "./chunked-messenger";
import { WebRtcService, type WebRtcServiceDeps } from "./web-rtc-service";

export { WebRtcService } from "./web-rtc-service";
export type { WebRtcServiceDeps } from "./web-rtc-service";
export { ChunkedMessenger } from "./chunked-messenger";
export type { ChunkedMessengerDeps, RawMessaging } from "./chunked-messenger";
export type { RtcPeer, RtcPeerStatus, HostTransferResult } from "./types";
export type { RtcConnectionProvider } from "./ports/rtc-connection-provider";
export type { RtcDataChannelPort } from "./ports/rtc-data-channel-port";
export type {
  IceCandidate,
  PeerConnectionState,
  RtcPeerConnectionPort,
  SessionDescription,
} from "./ports/rtc-peer-connection-port";
// RtcPeerRegistry, RtcPeerLinkFactory, RtcReconnectionManager, RtcLinkNegotiator and
// ActiveRtcConnection are deliberately NOT exported. They're wiring, not API.

export function createWebRtcService(overrides: Partial<WebRtcServiceDeps> = {}): WebRtcService {
  const config = overrides.config ?? DEFAULT_CONFIG.webrtc;
  const clock = overrides.clock ?? new SystemClock();
  return new WebRtcService({
    ...overrides,
    clock,
    ids: overrides.ids ?? new UlidIdGenerator(clock),
    logger: overrides.logger ?? new ConsoleLogger("webrtc"),
    config,
    session: overrides.session ?? createSignalingSession(),
    connections: overrides.connections ?? new BrowserRtcConnectionProvider(config.iceServers),
  });
}

export function createChunkedMessenger(
  rtc: WebRtcService,
  overrides: Partial<ChunkedMessengerDeps> = {}
): ChunkedMessenger {
  const clock = overrides.clock ?? new SystemClock();
  return new ChunkedMessenger({
    config: DEFAULT_CONFIG.webrtc,
    ...overrides,
    rtc,
    clock,
    ids: overrides.ids ?? new UlidIdGenerator(clock),
  });
}
