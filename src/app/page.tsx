import { WebRtcAutoTest } from "@/presentation/temp/WebRtcAutoTest";

interface HomeProps {
  searchParams: Promise<{
    isHost?: string;
  }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;

  return <WebRtcAutoTest />;
}
