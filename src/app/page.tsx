import { SignalingServiceRootTest } from "@/presentation/temp/SignalingRootTest";
import { WebRtcTest } from "@/presentation/temp/WebRtcTest";

interface HomeProps {
  searchParams: Promise<{
    isHost?: string;
  }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;

  return <WebRtcTest />;
}
