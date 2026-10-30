"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getProfileStorage } from "@/compose";
import { DEFAULT_ROSTER_CONFIG, openProfile } from "@/roster";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";

// Room ids end up in a Firestore document path and in the URL: keep them simple.
const ROOM_CODE = /^[A-Za-z0-9_-]{3,32}$/;

const openNickname = () => openProfile(getProfileStorage(), DEFAULT_ROSTER_CONFIG.profileTtlMs);

/** Nickname, then create a room or join one by code. The nickname is remembered for the room to pick up. */
export function EntryScreen() {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Prefill from the cookie after mount (the server has no cookie), without a state update.
  useEffect(() => {
    const saved = openNickname().loadName();
    if (saved && nameRef.current && !nameRef.current.value) nameRef.current.value = saved;
  }, []);

  // No playerId in the URL: the room provider mints one per tab and keeps it.
  function enter(roomId: string) {
    const name = nameRef.current?.value.trim();
    if (name) openNickname().saveName(name.slice(0, DEFAULT_ROSTER_CONFIG.maxNameLength));
    router.push(`/room/${encodeURIComponent(roomId)}`);
  }

  function create() {
    enter(crypto.randomUUID().slice(0, 8));
  }

  function join(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    if (!ROOM_CODE.test(code)) {
      setError("Use 3–32 letters, numbers, dashes or underscores.");
      return;
    }
    setError(null);
    enter(code);
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="font-heading text-2xl font-semibold">Spyxgame</h1>

      <div className="space-y-2">
        <label htmlFor="nickname" className="text-sm text-muted-foreground">
          Your name
        </label>
        <Input
          id="nickname"
          ref={nameRef}
          autoComplete="nickname"
          maxLength={DEFAULT_ROSTER_CONFIG.maxNameLength}
          placeholder={DEFAULT_ROSTER_CONFIG.defaultName}
        />
      </div>

      <Button size="lg" onClick={create}>
        Create room
      </Button>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={join} className="space-y-2">
        <div className="flex gap-2">
          <Input
            name="code"
            aria-label="Room code"
            aria-invalid={error !== null}
            autoCapitalize="none"
            autoComplete="off"
            placeholder="Room code"
            onChange={() => setError(null)}
          />
          <Button type="submit" variant="outline" size="lg">
            Join
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
    </main>
  );
}
