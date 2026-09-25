import { PlayerSessionTest } from "@/shared/presentation/PlayerSessionTest";

interface HomeProps {
  searchParams: Promise<{
    isHost?: string;
  }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;

  return <PlayerSessionTest />;
}
