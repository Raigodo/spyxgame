export interface IdGenerator {
  /** ULID in production: ids sort by creation time (the host election relies on it). */
  next(): string;
}
