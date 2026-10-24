import { GameScreen } from "@/ui/game-screen";

export default async function Page({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  return <GameScreen gameId={game} />;
}
