import type { BusSync } from "@/bus";
import { cn } from "cn";

const LOOK: Record<BusSync, { dot: string; label: string }> = {
  ready: { dot: "bg-emerald-500", label: "Connected" },
  syncing: { dot: "animate-pulse bg-amber-500", label: "Syncing" },
  lost: { dot: "animate-pulse bg-destructive", label: "Connection lost, reconnecting" },
};

/** The room's connection state as one small dot. State, not an event: no toast, no overlay. */
export function ConnectionDot({ sync }: { sync: BusSync }) {
  const { dot, label } = LOOK[sync];
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="flex size-4 items-center justify-center"
    >
      <span className={cn("size-2 rounded-full", dot)} />
    </span>
  );
}
