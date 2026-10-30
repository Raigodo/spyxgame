"use client";

import Link from "next/link";
import { CopyIcon, SignOutIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/ui/components/ui/button";
import { PlayersMenu } from "../players/players-menu";
import { useRoom } from "../room-context";
import { useStore } from "../use-store";
import { ConnectionDot } from "./connection-dot";

/** Room code with the connection dot (click to copy the invite link), a slot for the page, and Leave. */
export function RoomHeader({ slotRef }: { slotRef: (el: HTMLDivElement | null) => void }) {
  const room = useRoom();
  const sync = useStore(room.sync);

  // The room URL carries no player id, so the address bar is the invite link.
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Invite link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
      <Button
        variant="ghost"
        size="sm"
        className="font-mono"
        aria-label="Copy invite link"
        onClick={() => void copyInvite()}
      >
        <ConnectionDot sync={sync} />
        {room.roomId}
        <CopyIcon />
      </Button>
      <div ref={slotRef} className="flex min-w-0 flex-1 items-center justify-end gap-2" />
      <PlayersMenu />
      <Link
        href="/room"
        aria-label="Leave room"
        title="Leave room"
        className={buttonVariants({ variant: "ghost", size: "icon" })}
      >
        <SignOutIcon />
      </Link>
    </header>
  );
}
