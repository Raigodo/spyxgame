import type { GameBackend } from "./game-handle";
import { MAX_LOCAL_LENGTH, type LocalStateDef } from "./local-state";

type LocalBackend = Pick<
  GameBackend,
  "readLocal" | "writeLocal" | "onLocalChanged" | "onSlotChanged"
>;

// One local piece of one game. get() keeps its reference until the stored value changes.
export class LocalHandle<L> {
  private raw: string | undefined;
  private readonly fallback: L;
  private value: L;

  constructor(
    private readonly def: LocalStateDef<L>,
    private readonly backend: LocalBackend,
    private readonly gameId: string
  ) {
    this.fallback = def.initial();
    this.value = this.fallback;
  }

  /** The stored value, or initial() while the game is not active or nothing valid is stored. */
  get(): L {
    const raw = this.backend.readLocal(this.gameId, this.def.id);
    if (raw === this.raw) return this.value;
    this.raw = raw;
    this.value = this.parse(raw) ?? this.fallback;
    return this.value;
  }

  /** No-op while the game is not active. Oversized values are dropped. */
  set(next: L): void {
    const raw = JSON.stringify(next);
    if (raw.length > MAX_LOCAL_LENGTH) return;
    this.backend.writeLocal(this.gameId, this.def.id, raw);
  }

  /** Fires on a write, and when the slot changes (a new round has its own state). */
  onChanged(handler: () => void): () => void {
    const offs = [
      this.backend.onLocalChanged(this.gameId, this.def.id, handler),
      this.backend.onSlotChanged(this.gameId, handler),
    ];
    return () => offs.forEach((off) => off());
  }

  private parse(raw: string | undefined): L | undefined {
    if (raw === undefined) return undefined;
    try {
      return this.def.validate(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
}
