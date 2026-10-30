import type { ReactNode } from "react";
import { cn } from "cn";

/** One bordered block of a game page, with an optional title. Panels do not nest. */
export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      {title && <h2 className="text-sm font-medium">{title}</h2>}
      {children}
    </section>
  );
}

/** Quiet explanatory text. */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

/** A rejected action, in words. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

/** A line that must not be missed: your secret role, the word. */
export function Callout({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        tone === "danger" ? "border-destructive/40 bg-destructive/10 text-destructive" : "bg-muted"
      )}
    >
      {children}
    </div>
  );
}
