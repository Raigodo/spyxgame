import type { RtcConnectionProvider } from "../ports/rtc-connection-provider";
import type { RtcPeerConnectionPort } from "../ports/rtc-peer-connection-port";
import type { FakeRtcNetwork } from "./fake-rtc-network";
import { FakeRtcPeerConnection } from "./fake-rtc-peer-connection";

export class FakeRtcConnectionProvider implements RtcConnectionProvider {
  constructor(
    private readonly network: FakeRtcNetwork,
    private readonly owner: string
  ) {}

  create(): RtcPeerConnectionPort {
    return new FakeRtcPeerConnection(this.owner, this.network);
  }
}
