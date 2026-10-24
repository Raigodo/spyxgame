import type { IceServer } from "../../../config";
import type { RtcConnectionProvider } from "../../ports/rtc-connection-provider";
import type { RtcPeerConnectionPort } from "../../ports/rtc-peer-connection-port";
import { BrowserRtcPeerConnectionAdapter } from "./browser-rtc-peer-connection-adapter";

export class BrowserRtcConnectionProvider implements RtcConnectionProvider {
  create(iceServers: readonly IceServer[]): RtcPeerConnectionPort {
    const servers: RTCIceServer[] = iceServers.map((server) => ({
      ...server,
      urls: typeof server.urls === "string" ? server.urls : [...server.urls],
    }));
    return new BrowserRtcPeerConnectionAdapter(new RTCPeerConnection({ iceServers: servers }));
  }
}
