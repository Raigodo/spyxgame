import type { DataChannelState, RtcDataChannelPort } from "../../ports/rtc-data-channel-port";

export class BrowserRtcDataChannelAdapter implements RtcDataChannelPort {
  constructor(private readonly channel: RTCDataChannel) {}

  get readyState(): DataChannelState {
    return this.channel.readyState;
  }

  send(data: string): void {
    this.channel.send(data);
  }

  close(): void {
    this.channel.close();
  }

  onOpen(handler: () => void): void {
    this.channel.onopen = () => handler();
  }

  onMessage(handler: (data: string) => void): void {
    this.channel.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") handler(event.data); // only strings are ever sent
    };
  }

  onClose(handler: () => void): void {
    this.channel.onclose = () => handler();
  }

  onError(handler: (error: unknown) => void): void {
    this.channel.onerror = (event) => handler(event);
  }
}
