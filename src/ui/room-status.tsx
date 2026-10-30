"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { SpinnerIcon } from "@phosphor-icons/react";
import type { RoomEnd } from "@/room";
import { Button, buttonVariants } from "@/ui/components/ui/button";

/** A whole-page message: this tab cannot be in the room right now, so there is nothing behind it to return to. */
function Notice({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-base font-medium">{title}</p>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {children}
    </main>
  );
}

const BackToStart = () => (
  <Link href="/room" className={buttonVariants({ size: "lg" })}>
    Back to start
  </Link>
);

export const ConnectingNotice = () => (
  <main
    role="status"
    className="mx-auto flex min-h-svh w-full max-w-sm flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
  >
    <SpinnerIcon className="size-5 animate-spin" />
    <p className="text-sm">Connecting…</p>
  </main>
);

export const JoinFailedNotice = () => (
  <Notice title="Couldn't join the room." hint="Check your connection and try again.">
    <Button size="lg" onClick={() => window.location.reload()}>
      Try again
    </Button>
  </Notice>
);

const ENDED: Record<RoomEnd["reason"], { title: string; hint?: string }> = {
  superseded: {
    title: "You're playing in another tab.",
    hint: "Each player can be in a room once at a time.",
  },
  kicked: { title: "You were removed from the room." },
  full: { title: "The room is full." },
};

export function RoomEndedNotice({ reason }: { reason: RoomEnd["reason"] }) {
  const { title, hint } = ENDED[reason];
  return (
    <Notice title={title} {...(hint !== undefined && { hint })}>
      <BackToStart />
    </Notice>
  );
}
