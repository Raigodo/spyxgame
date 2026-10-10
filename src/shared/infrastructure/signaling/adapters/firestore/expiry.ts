import { Timestamp } from "firebase/firestore";
import type { Clock, SignalingConfig } from "@/shared/kernel";

/** What the Firestore adapters need to stamp documents with a TTL expiry. */
export interface Retention {
  clock: Clock;
  config: SignalingConfig;
}

/** The value of the `expiresAt` field a Firestore TTL policy deletes by. */
export function expiresAt(clock: Pick<Clock, "now">, ttlMs: number, from = clock.now()): Timestamp {
  return Timestamp.fromMillis(from + ttlMs);
}
