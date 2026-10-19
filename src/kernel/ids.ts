export type Brand<T, B extends string> = T & { readonly __brand: B };

export type PlayerId = Brand<string, "PlayerId">;
export type PeerId = Brand<string, "PeerId">;
export type RoomId = Brand<string, "RoomId">;
export type ChannelId = Brand<string, "ChannelId">;

export interface IdKinds {
  player: PlayerId;
  peer: PeerId;
  room: RoomId;
  channel: ChannelId;
}

/**
 * One cap per id kind. Chosen from the legacy caps (32 room code, 64 game/timer id, 100 spy id,
 * 128 playerId): playerId keeps 128 (it comes from the URL), a peerId is a 26-char ULID, a room
 * code is at most 32, a channel id is `game:<id>:private` at most.
 */
export const ID_LIMITS: Record<keyof IdKinds, number> = {
  player: 128,
  peer: 64,
  room: 32,
  channel: 96,
};

/** Cast a plain string. Only where a value is created or parsed: `as<PlayerId>(raw)`. */
export function as<T extends Brand<string, string>>(value: string): T {
  return value as T;
}
