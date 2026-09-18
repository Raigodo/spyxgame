const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export class RtcConnectionFactory {
  constructor(private readonly iceServers: RTCIceServer[] = ICE_SERVERS) {}

  create(): RTCPeerConnection {
    return new RTCPeerConnection({ iceServers: this.iceServers });
  }
}
