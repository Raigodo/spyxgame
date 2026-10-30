"use client";

import { useState, type ReactNode } from "react";
import { HeaderSlotContext } from "./header-slot";
import { RoomHeader } from "./room-header";
import { RoomToasts } from "./room-toasts";

/** Header on top, the page below. Everything inside a room renders through this. */
export function AppShell({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <HeaderSlotContext value={slot}>
      <div className="flex min-h-svh flex-col">
        <RoomToasts />
        <RoomHeader slotRef={setSlot} />
        <main className="mx-auto w-full max-w-xl flex-1 space-y-4 p-4">{children}</main>
      </div>
    </HeaderSlotContext>
  );
}
