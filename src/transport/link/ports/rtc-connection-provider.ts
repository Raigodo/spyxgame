import type { IceServer } from "../../config";
import type { RtcPeerConnectionPort } from "./rtc-peer-connection-port";

/** One new connection per link. The ICE servers are resolved per join and passed in. */
export interface RtcConnectionProvider {
  create(iceServers: readonly IceServer[]): RtcPeerConnectionPort;
}
