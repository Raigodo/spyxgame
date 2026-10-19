import type { Entropy } from "@/kernel";

export class CryptoEntropy implements Entropy {
  seed(): number {
    return crypto.getRandomValues(new Uint32Array(1))[0] as number;
  }
}
