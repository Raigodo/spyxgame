import type { RtcPeerConnectionPort } from "./rtc-peer-connection-port";

/** One new connection per link. ICE servers and other settings live inside the implementation. */
export interface RtcConnectionProvider {
  create(): RtcPeerConnectionPort;
}
