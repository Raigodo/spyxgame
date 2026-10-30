"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The element inside the header that pages may fill. Set by AppShell. */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

/**
 * Puts its children in the header, after the room code. The page on screen decides what the header
 * shows: a title (give it `mr-auto` to keep it left) and quick actions. Renders nothing until the header exists.
 */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const target = useContext(HeaderSlotContext);
  return target ? createPortal(children, target) : null;
}
