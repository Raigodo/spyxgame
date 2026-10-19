/** The only source of randomness for per-round seeds. */
export interface Entropy {
  /** An unsigned 32-bit integer. */
  seed(): number;
}
