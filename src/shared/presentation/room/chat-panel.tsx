// Built-in room chat: the same component in the lobby and in every game.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRoom } from "./room-context";
import { useChat, usePlayers } from "./room-hooks";

const HINTS = {
  "rate-limited": "Slow down a little.",
  "not-ready": "Reconnecting — try again in a moment.",
  invalid: "That message can't be sent.",
} as const;

export function ChatPanel() {
  const { client } = useRoom();
  const lines = useChat();
  const players = usePlayers();

  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("all");
  const [hint, setHint] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const localPeerId = client.getLocalPeerId();
  const others = players.filter((p) => p.peerId !== localPeerId);
  // If the selected recipient left, fall back to everyone.
  const activeTarget = target === "all" || others.some((p) => p.peerId === target) ? target : "all";

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lines.length]);

  function send() {
    const result = client.sendChat(draft, activeTarget === "all" ? undefined : activeTarget);
    if (result === "sent") {
      setDraft("");
      setHint(null);
    } else {
      setHint(HINTS[result]); // keep the draft
    }
  }

  return (
    <section className="space-y-2">
      <div
        ref={listRef}
        className="space-y-1 bg-slate-900 p-3 border border-slate-800 rounded h-64 overflow-y-auto text-sm"
      >
        {lines.map((l) => (
          <div key={l.id} className={l.direct ? "text-amber-300" : ""}>
            <span className="text-slate-500">
              {l.mine
                ? l.direct
                  ? `you → ${l.toName}`
                  : "you"
                : l.direct
                  ? `${l.fromName} (direct)`
                  : l.fromName}
              :
            </span>{" "}
            {l.text}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <select
          className="bg-slate-900 px-2 py-1 border border-slate-700 rounded"
          value={activeTarget}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="all">Everyone</option>
          {others.map((p) => (
            <option key={p.peerId} value={p.peerId}>
              {p.nickname}
            </option>
          ))}
        </select>
        <input
          className="flex-1 bg-slate-900 px-2 py-1 border border-slate-700 rounded"
          placeholder="Message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="bg-emerald-700 px-4 py-1 rounded font-semibold" onClick={send}>
          Send
        </button>
      </div>
      {hint && <p className="text-amber-400 text-xs">{hint}</p>}
    </section>
  );
}
