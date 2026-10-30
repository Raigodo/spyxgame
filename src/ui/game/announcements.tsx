"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/ui/dialog";

/** Something worth stopping for: a winner, a role reveal. `key` makes it show once, however often the page re-renders. */
export type Announcement = { key: string; title: string; description?: string };

const AnnounceContext = createContext<((a: Announcement) => void) | undefined>(undefined);

/**
 * Shows announcements one at a time, in the order they arrive, as a dialog that can always be closed.
 * `actions` are extra footer buttons (the host's "Back to lobby").
 */
export function AnnouncementProvider({
  actions,
  children,
}: {
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [queue, setQueue] = useState<readonly Announcement[]>([]);
  const seen = useRef(new Set<string>());

  const announce = useCallback((a: Announcement) => {
    if (seen.current.has(a.key)) return;
    seen.current.add(a.key);
    setQueue((q) => [...q, a]);
  }, []);
  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);

  const current = queue[0];
  return (
    <AnnounceContext value={announce}>
      {children}
      <Dialog open={current !== undefined} onOpenChange={(open) => !open && dismiss()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{current?.title}</DialogTitle>
            {current?.description && <DialogDescription>{current.description}</DialogDescription>}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismiss}>
              Close
            </Button>
            {actions}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AnnounceContext>
  );
}

/**
 * Call from a game page. Pass an announcement while the moment is true, undefined otherwise:
 * `useAnnouncement(winner ? { key: `winner:${round}`, title: `${winner} wins!` } : undefined)`.
 */
export function useAnnouncement(announcement: Announcement | undefined): void {
  const announce = useContext(AnnounceContext);
  if (!announce) throw new Error("useAnnouncement must be used inside a game page.");

  const key = announcement?.key;
  const title = announcement?.title;
  const description = announcement?.description;
  useEffect(() => {
    if (key === undefined || title === undefined) return;
    announce({ key, title, ...(description !== undefined && { description }) });
  }, [announce, key, title, description]);
}
