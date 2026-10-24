import type { ReactNode } from "react";

export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="bg-slate-950 p-6 min-h-screen text-slate-200 text-sm">
      <div className="space-y-6 mx-auto w-full max-w-xl">{children}</div>
    </div>
  );
}
