import Link from "next/link";
import type { ReactNode } from "react";
import { useRoom } from "./room-context";
import { btn } from "./styles";
import { useStore } from "./use-store";

export function RoomHeader({ title, children }: { title: string; children?: ReactNode }) {
  const room = useRoom();
  const role = useStore(room.role);
  const sync = useStore(room.sync);
  return (
    <header className="flex justify-between items-center gap-3">
      <div>
        <h1 className="font-semibold text-lg">{title}</h1>
        <p className="text-slate-500 text-xs">
          Room <span className="font-mono text-slate-300">{room.roomId}</span> · {role} · {sync}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {children}
        <Link href="/room" className={btn}>
          Leave
        </Link>
      </div>
    </header>
  );
}
