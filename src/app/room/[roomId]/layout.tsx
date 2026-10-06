import { Suspense, type ReactNode } from "react";
import { RoomProvider } from "@/shared/presentation/room/room-provider";

export default function RoomLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={<div className="bg-slate-950 p-6 min-h-screen text-slate-200">Loading…</div>}
    >
      <RoomProvider>{children}</RoomProvider>
    </Suspense>
  );
}
