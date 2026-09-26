import LobbyTestHarness from "@/shared/presentation/LobbyTest";

interface HomeProps {
  searchParams: Promise<{
    isHost?: string;
  }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;

  return <LobbyTestHarness />;
}
