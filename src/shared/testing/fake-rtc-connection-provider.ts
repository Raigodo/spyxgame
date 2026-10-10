import type { RtcConnectionProvider } from "@/shared/infrastructure/webrtc";
import type { RtcPeerConnectionPort } from "@/shared/infrastructure/webrtc";
import { FakeRtcNetwork } from "./fake-rtc-network";
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
