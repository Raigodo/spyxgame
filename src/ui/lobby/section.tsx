import type { ReactNode } from "react";

/** A titled block of the lobby. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-2 text-xs text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}
