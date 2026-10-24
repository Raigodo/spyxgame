export type DataChannelState = "connecting" | "open" | "closing" | "closed";

/** Each `on…` replaces the previous handler for that event. */
export interface RtcDataChannelPort {
  readonly readyState: DataChannelState;
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
}
