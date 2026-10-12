// The lobby's game picker. Each game contributes one entry: its label, the lobby modes it supports,
// and a small component that renders only that game's config inputs and its Start button.
// Adding a game = one entry here (plus its entry in games.ts and its page).

import type { ComponentType } from "react";
import type { LobbyMode } from "@/shared/application/lobby";
import type { CommandResult } from "@/shared/application/messaging";
import { demoTap } from "@/demo-tap/demo-tap";
import { DemoTapStarter } from "@/demo-tap/demo-tap-starter";
import { spyGame } from "@/spy/spy";
import { SpyStarter } from "@/spy/spy-starter";

export interface LobbyStarterProps {
  /** True while the room is syncing: the Start button must not fire. */
  disabled: boolean;
  /** Called with the host's verdict after Start, so the lobby can show a rejection. */
  onResult(result: CommandResult): void;
}

export interface LobbyGameEntry {
  id: string;
  label: string;
  modes: readonly LobbyMode[];
  Starter: ComponentType<LobbyStarterProps>;
}

export const LOBBY_GAMES: readonly LobbyGameEntry[] = [
  { id: demoTap.id, label: "Tap race", modes: demoTap.spec.modes, Starter: DemoTapStarter },
  { id: spyGame.id, label: "Spy", modes: spyGame.spec.modes, Starter: SpyStarter },
];
