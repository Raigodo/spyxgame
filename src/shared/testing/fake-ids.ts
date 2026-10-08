import type { IdGenerator } from "@/shared/kernel";

/** Sequential ids that sort in creation order, like ULIDs. */
export class FakeIds implements IdGenerator {
  private n = 0;
  next(): string {
    return `id-${String(++this.n).padStart(4, "0")}`;
  }
}
