import { HostElectionTest } from "@/presentation/temp/HostElectionTest";
import { RtcManualTest } from "@/presentation/temp/RtcManualTest";
import { SignalingServiceRootTest } from "@/presentation/temp/SignalingRootTest";
import { WebRtcServiceTest } from "@/presentation/temp/WebRtcServiceTest";
import { WebRtcTest } from "@/presentation/temp/WebRtcTest";

interface HomeProps {
  searchParams: Promise<{
    isHost?: string;
  }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;

  return <WebRtcServiceTest />;
}
