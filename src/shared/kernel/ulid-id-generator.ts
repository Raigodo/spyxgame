import { ulid } from "ulid";
import type { Clock } from "./clock";
import type { IdGenerator } from "./id-generator";

/**
 * ULIDs sort lexicographically by creation time, which the host election relies on:
 * the oldest peer id wins. The clock is injected so tests get deterministic ids.
 */
export class UlidIdGenerator implements IdGenerator {
  constructor(private readonly clock: Clock) {}

  next(): string {
    return ulid(this.clock.now());
  }
}
