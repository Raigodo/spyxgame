import type { ReactNode } from "react";
import { RoomNavigator } from "@/ui/room-navigator";
import { RoomProvider } from "@/ui/room-provider";
import { AppShell } from "@/ui/shell/app-shell";

export default async function RoomLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return (
    <RoomProvider key={roomId} roomId={roomId}>
      <RoomNavigator />
      <AppShell>{children}</AppShell>
    </RoomProvider>
  );
}
