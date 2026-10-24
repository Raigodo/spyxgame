import { isRecord } from "@/kernel";
import type { IceServerSource } from "@/transport";

type IceServers = Awaited<ReturnType<IceServerSource["fetch"]>>;

const isString = (v: unknown): v is string => typeof v === "string";

function toServer(item: unknown): IceServers[number][] {
  if (!isRecord(item)) return [];
  const { urls, username, credential } = item;
  const list = isString(urls) ? urls : Array.isArray(urls) ? urls.filter(isString) : undefined;
  if (!list || list.length === 0) return [];
  return [
    {
      urls: list,
      ...(isString(username) && { username }),
      ...(isString(credential) && { credential }),
    },
  ];
}

/** Relay servers from `/api/turn`. Network input: anything off is dropped; empty means STUN only. */
export class TurnIceServerSource implements IceServerSource {
  constructor(private readonly url = "/api/turn") {}

  async fetch(): Promise<IceServers> {
    const response = await fetch(this.url, { cache: "no-store" });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const raw = isRecord(body) ? body.iceServers : undefined;
    const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
    return list.flatMap(toServer);
  }
}
